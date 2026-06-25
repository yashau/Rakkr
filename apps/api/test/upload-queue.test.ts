import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const queueRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-queue-"));
process.env.RAKKR_UPLOAD_QUEUE_MAX_ATTEMPTS = "2";
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(queueRoot, "queue.json");

const {
  enqueueRecordingUpload,
  listUploadQueueItems,
  retryUploadQueueItem,
  succeedUploadQueueItem,
} = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(queueRoot, { force: true, recursive: true });
});

test("queues cached recordings and retries failed stub uploads", async () => {
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

  const retrying = await retryUploadQueueItem(queued.id);

  assert.equal(retrying?.attemptCount, 1);
  assert.equal(retrying?.lastError, "provider_not_configured");
  assert.equal(retrying?.status, "retrying");

  const failed = await retryUploadQueueItem(queued.id);

  assert.equal(failed?.attemptCount, 2);
  assert.equal(failed?.status, "failed");
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
