import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";
import { memoryRecordingStore } from "./recording-store-mock.js";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-runner-cache-verify-"));
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(runnerRoot, "destinations.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(runnerRoot, "policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(runnerRoot, "queue.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(runnerRoot, "cache");
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(runnerRoot, "chunks.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");
const { createUploadRunner } = await import("../src/upload-runner.js");
const { enqueueRecordingUpload } = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(runnerRoot, { force: true, recursive: true });
});

test("R25: an unverified (provider_declared) S3 upload keeps the controller cache even when the policy deletes it", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "unverified-s3-bytes";
  const cachedRecording = recording("rec_upload_unverified_s3", contents);
  const cachePath = await cacheRecording(cachedRecording.id, contents);
  const recordingStore = memoryRecordingStore([cachedRecording]);
  const runner = createUploadRunner({
    auditStore,
    destinationStore,
    limit: 5,
    recordingStore,
    // A stub S3 sender that accepts the object without validating the checksum,
    // exactly like a custom S3-compatible endpoint that ignores ChecksumSHA256.
    s3Client: { async send() {} },
  });

  // A custom endpoint yields `provider_declared` verification (see upload-executor).
  const destination = await destinationStore.create({
    displayName: "Custom S3",
    enabled: true,
    kind: "s3",
    s3: {
      accessKeyId: "AKIAEXAMPLE",
      bucket: "rakkr-archive",
      endpoint: "https://minio.example.lan",
      region: "us-east-1",
    },
    s3SecretAccessKey: "s3-secret",
  });
  const policy = await createUploadPolicy({
    deleteCacheAfterUpload: true,
    destinationId: destination.id,
    enabled: true,
    maxAttempts: 1,
    name: "Archive to custom S3 then delete cache",
    trigger: "manual",
  });
  await enqueueRecordingUpload(cachedRecording, {
    destinationId: destination.id,
    maxAttempts: 1,
    policyId: policy.id,
    provider: "s3",
  });

  const summary = await runner.runOnce();
  const updated = await recordingStore.find(cachedRecording.id);
  const reconcileEvents = await auditStore.list({
    action: "recordings.upload_queue.reconciled.succeeded",
  });

  assert.equal(summary.succeeded, 1);
  assert.equal(summary.items[0]?.checksumVerification?.status, "provider_declared");
  // Pre-fix the runner deleted the controller cache for a provider_declared upload
  // (checksum never read back), so a silently-corrupted object had no local
  // recovery source. The cache must be kept until the upload is genuinely verified.
  assert.equal(updated?.status, "uploaded");
  assert.equal(updated?.cached, true);
  assert.equal(updated?.cachePath, cachedRecording.cachePath);
  await assert.doesNotReject(readFile(cachePath));
  assert.deepEqual(reconcileEvents[0]?.details.retention, {
    policyId: policy.id,
    skipped: "upload_unverified",
  });
});

function recording(id = "rec_upload_runner_test", contents?: string): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    checksum: contents ? sha256Prefixed(contents) : `sha256:${id}`,
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

async function cacheRecording(id: string, contents: string) {
  const cachePath = path.join(runnerRoot, "cache", "scheduled", `${id}.mp3`);

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents);

  return cachePath;
}

function sha256Prefixed(contents: string) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}
