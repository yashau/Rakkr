import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const uploadRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-executor-"));
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(uploadRoot, "cache");
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(uploadRoot, "providers.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(uploadRoot, "queue.json");

const { createUploadProviderStore } = await import("../src/upload-providers.js");
const { runUploadQueueOnce } = await import("../src/upload-executor.js");
const { enqueueRecordingUpload, listUploadQueueItems } = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(uploadRoot, { force: true, recursive: true });
});

test("runs due stub upload queue items to success", async () => {
  const queued = await enqueueRecordingUpload(recording("rec_stub_upload"), {
    provider: "stub",
    target: "stub://queue-only",
  });
  const result = await runUploadQueueOnce({ limit: 5 });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);

  assert.equal(result.attempted, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.deferred, 0);
  assert.equal(item?.attemptCount, 1);
  assert.equal(item?.lastError, undefined);
  assert.equal(item?.status, "succeeded");
});

test("defers provider failures until the retry budget is exhausted", async () => {
  const providerStore = createUploadProviderStore();

  await providerStore.update("s3", {
    displayName: "Archive S3",
    enabled: true,
    target: "s3://rakkr-archive/meetings",
  });

  const queued = await enqueueRecordingUpload(recording("rec_s3_upload"), {
    maxAttempts: 1,
    provider: "s3",
    target: "s3://rakkr-archive/meetings",
  });
  const result = await runUploadQueueOnce({ providerStore });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);

  assert.equal(result.attempted, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.items[0]?.reason, "missing_credentialRef");
  assert.equal(item?.attemptCount, 1);
  assert.equal(item?.lastError, "missing_credentialRef");
  assert.equal(item?.status, "failed");
});

test("uploads SMB queue items to a mounted filesystem target", async () => {
  const providerStore = createUploadProviderStore();
  const target = path.join(uploadRoot, "mounted-share");

  await cacheRecording("rec_smb_upload", "smb-bytes");
  await providerStore.update("smb", {
    displayName: "Mounted Share",
    enabled: true,
    target,
  });

  const queued = await enqueueRecordingUpload(recording("rec_smb_upload"), {
    maxAttempts: 1,
    provider: "smb",
  });
  const result = await runUploadQueueOnce({ providerStore });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);
  const uploaded = await readFile(path.join(target, "Council Meeting.mp3"), "utf8");

  assert.equal(result.succeeded, 1);
  assert.equal(item?.status, "succeeded");
  assert.equal(uploaded, "smb-bytes");
});

test("uploads S3 queue items with bucket, key, and recording metadata", async () => {
  const providerStore = createUploadProviderStore();
  const sentCommands = [];

  await cacheRecording("rec_s3_ready_upload", "s3-bytes");
  await providerStore.update("s3", {
    credentialRef: "env://aws-test",
    displayName: "Archive S3",
    enabled: true,
    target: "s3://rakkr-archive/meetings",
  });

  const queued = await enqueueRecordingUpload(recording("rec_s3_ready_upload"), {
    maxAttempts: 1,
    provider: "s3",
  });
  const result = await runUploadQueueOnce({
    providerStore,
    s3Client: {
      async send(command) {
        sentCommands.push(command);
      },
    },
  });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);
  const input = sentCommands[0]?.input;

  assert.equal(result.succeeded, 1);
  assert.equal(item?.status, "succeeded");
  assert.equal(input?.Bucket, "rakkr-archive");
  assert.equal(input?.Key, "meetings/Council Meeting.mp3");
  assert.equal(input?.Metadata?.recording_id, "rec_s3_ready_upload");
});

function recording(id: string): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    checksum: `sha256:${id}`,
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
  const cachePath = path.join(uploadRoot, "cache", "scheduled", `${id}.mp3`);

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents);
}
