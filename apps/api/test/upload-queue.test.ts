import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const queueRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-queue-"));
process.env.RAKKR_UPLOAD_QUEUE_MAX_ATTEMPTS = "2";
process.env.RAKKR_UPLOAD_QUEUE_LEASE_SECONDS = "300";
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(queueRoot, "queue.json");

const {
  enqueueRecordingUpload,
  failUploadQueueItem,
  listDueUploadQueueItems,
  listUploadQueueItems,
  retryUploadQueueItem,
  startUploadQueueItem,
  succeedUploadQueueItem,
} = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(queueRoot, { force: true, recursive: true });
});

test("operator retry resets a terminally-failed stub upload to a fresh retrying attempt", async () => {
  const queued = await enqueueRecordingUpload(recording(), {
    reason: "manual_retry_test",
    target: "s3://future-bucket/meetings",
  });

  assert.equal(queued.attemptCount, 0);
  assert.equal(queued.fileName, "Council Meeting.mp3");
  assert.equal(queued.lastError, "manual_retry_test");
  assert.equal(queued.maxAttempts, 2);
  assert.equal(queued.provider, "stub");
  assert.equal(queued.status, "queued");
  assert.equal(queued.target, "s3://future-bucket/meetings");

  const duplicate = await enqueueRecordingUpload(recording());

  assert.equal(duplicate.id, queued.id);
  assert.equal((await listUploadQueueItems()).length, 1);

  // Exhaust the attempt budget (maxAttempts=2) via real start/fail cycles.
  await startUploadQueueItem(queued.id);
  await failUploadQueueItem(queued.id, "attempt_1");
  await startUploadQueueItem(queued.id);
  const failed = await failUploadQueueItem(queued.id, "attempt_2");

  assert.equal(failed?.attemptCount, 2);
  assert.equal(failed?.status, "failed");

  // Operator retry resets the budget so the runner re-attempts the failed item,
  // rather than incrementing an already-maxed count (which left it failed).
  const retried = await retryUploadQueueItem(queued.id);

  assert.equal(retried?.attemptCount, 0);
  assert.equal(retried?.status, "retrying");
  assert.equal(retried?.lastError, "provider_not_configured");
});

test("reuses succeeded upload queue item for the same cached artifact", async () => {
  const queued = await enqueueRecordingUpload(recording("rec_upload_idempotent"), {
    policyId: "upload-policy-idempotent",
    target: "s3://future-bucket/idempotent",
  });
  const succeeded = await succeedUploadQueueItem(queued.id);
  const duplicate = await enqueueRecordingUpload(recording("rec_upload_idempotent"), {
    policyId: "upload-policy-idempotent",
    target: "s3://future-bucket/idempotent",
  });
  const changed = await enqueueRecordingUpload(
    {
      ...recording("rec_upload_idempotent"),
      checksum: "sha256:changed",
    },
    {
      policyId: "upload-policy-idempotent",
      target: "s3://future-bucket/idempotent",
    },
  );

  assert.equal(succeeded?.status, "succeeded");
  assert.equal(duplicate.id, queued.id);
  assert.notEqual(changed.id, queued.id);
  assert.equal(
    (await listUploadQueueItems()).filter((item) => item.recordingId === "rec_upload_idempotent")
      .length,
    2,
  );
});

test("leases started upload queue items until crash recovery makes them due again", async () => {
  const startedAt = new Date("2026-06-18T12:00:00.000Z");
  const beforeLeaseExpiry = new Date("2026-06-18T12:04:59.000Z");
  const afterLeaseExpiry = new Date("2026-06-18T12:05:00.000Z");
  const queued = await enqueueRecordingUpload(recording("rec_upload_lease_recovery"), {
    target: "s3://future-bucket/lease-recovery",
  });
  const started = await startUploadQueueItem(queued.id, startedAt);
  const deferred = await listDueUploadQueueItems(beforeLeaseExpiry);
  const recovered = await listDueUploadQueueItems(afterLeaseExpiry);

  assert.equal(started?.attemptCount, 1);
  assert.equal(started?.lastError, undefined);
  assert.equal(started?.nextAttemptAt, "2026-06-18T12:05:00.000Z");
  assert.equal(started?.status, "retrying");
  assert.ok(!deferred.some((item) => item.id === queued.id));
  assert.ok(recovered.some((item) => item.id === queued.id));
});

test("G57: active items for one destination but different policy/path do not collapse", async () => {
  const rec = recording("rec_upload_multi_policy");
  const first = await enqueueRecordingUpload(rec, {
    destinationId: "dest-shared",
    pathOverride: "archive/2026",
    policyId: "upload-policy-archive",
    provider: "smb",
  });
  const second = await enqueueRecordingUpload(rec, {
    destinationId: "dest-shared",
    pathOverride: "working/latest",
    policyId: "upload-policy-working",
    provider: "smb",
  });
  const items = (await listUploadQueueItems()).filter((item) => item.recordingId === rec.id);

  // Pre-fix the active-status dedup ignored pathOverride/uploadPolicyId and
  // collapsed the second policy's distinct-subfolder upload into the first item,
  // silently dropping it.
  assert.notEqual(second.id, first.id);
  assert.equal(items.length, 2);

  // A genuine idempotent re-enqueue (same policy + path) still dedups.
  const duplicate = await enqueueRecordingUpload(rec, {
    destinationId: "dest-shared",
    pathOverride: "archive/2026",
    policyId: "upload-policy-archive",
    provider: "smb",
  });

  assert.equal(duplicate.id, first.id);
});

test("R28: re-enqueue after a terminal failure creates a fresh queue item", async () => {
  const rec = recording("rec_upload_failed_reenqueue");
  const queued = await enqueueRecordingUpload(rec, {
    destinationId: "dest-failed-reenqueue",
    pathOverride: "archive/2026",
    policyId: "upload-policy-failed-reenqueue",
    provider: "smb",
  });

  // Exhaust the attempt budget (maxAttempts=2) so the item is terminally failed.
  await startUploadQueueItem(queued.id);
  await failUploadQueueItem(queued.id, "attempt_1");
  await startUploadQueueItem(queued.id);
  const failed = await failUploadQueueItem(queued.id, "attempt_2");

  assert.equal(failed?.status, "failed");

  // Re-enqueue the SAME recording+policy+pathOverride. A terminal `failed` item is
  // not reusable, so a NEW upload item must be created (the old failed row lingers
  // as a record) rather than silently reusing the stale FAILED one.
  const reenqueued = await enqueueRecordingUpload(rec, {
    destinationId: "dest-failed-reenqueue",
    pathOverride: "archive/2026",
    policyId: "upload-policy-failed-reenqueue",
    provider: "smb",
  });

  assert.notEqual(reenqueued.id, queued.id);
  assert.equal(reenqueued.status, "queued");
  assert.equal(
    (await listUploadQueueItems()).filter((item) => item.recordingId === rec.id).length,
    2,
  );
});

test("R28: an in-flight (queued/retrying) item still dedups a re-enqueue", async () => {
  const rec = recording("rec_upload_inflight_dedup");
  const first = await enqueueRecordingUpload(rec, {
    destinationId: "dest-inflight-dedup",
    pathOverride: "archive/2026",
    policyId: "upload-policy-inflight-dedup",
    provider: "smb",
  });

  // A `queued` item dedups.
  const duplicateQueued = await enqueueRecordingUpload(rec, {
    destinationId: "dest-inflight-dedup",
    pathOverride: "archive/2026",
    policyId: "upload-policy-inflight-dedup",
    provider: "smb",
  });

  assert.equal(duplicateQueued.id, first.id);

  // A `retrying` (leased/failed-but-retryable) item still dedups.
  const retrying = await startUploadQueueItem(first.id);

  assert.equal(retrying?.status, "retrying");

  const duplicateRetrying = await enqueueRecordingUpload(rec, {
    destinationId: "dest-inflight-dedup",
    pathOverride: "archive/2026",
    policyId: "upload-policy-inflight-dedup",
    provider: "smb",
  });

  assert.equal(duplicateRetrying.id, first.id);
  assert.equal(
    (await listUploadQueueItems()).filter((item) => item.recordingId === rec.id).length,
    1,
  );
});

function recording(id = "rec_upload_test"): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    checksum: "sha256:test",
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id,
    name: "Council Meeting",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: ["council"],
  };
}
