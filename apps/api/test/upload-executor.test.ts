import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const contents = "smb-bytes";

  await cacheRecording("rec_smb_upload", contents);
  await providerStore.update("smb", {
    displayName: "Mounted Share",
    enabled: true,
    target,
  });

  const queued = await enqueueRecordingUpload(recording("rec_smb_upload", contents), {
    maxAttempts: 1,
    provider: "smb",
  });
  const result = await runUploadQueueOnce({ providerStore });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);
  const uploaded = await readFile(path.join(target, "Council Meeting.mp3"), "utf8");

  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.items[0]?.checksumVerification, {
    algorithm: "sha256",
    expected: sha256Prefixed(contents),
    method: "file_copy_sha256",
    observed: sha256Prefixed(contents),
    status: "matched",
  });
  assert.equal(item?.status, "succeeded");
  assert.equal(uploaded, "smb-bytes");
});

test("uploads S3 queue items with bucket, key, and recording metadata", async () => {
  const providerStore = createUploadProviderStore();
  const sentCommands = [];
  const contents = "s3-bytes";

  await cacheRecording("rec_s3_ready_upload", contents);
  await providerStore.update("s3", {
    credentialRef: "env://aws-test",
    displayName: "Archive S3",
    enabled: true,
    target: "s3://rakkr-archive/meetings",
  });

  const queued = await enqueueRecordingUpload(recording("rec_s3_ready_upload", contents), {
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
  assert.deepEqual(result.items[0]?.checksumVerification, {
    algorithm: "sha256",
    expected: sha256Prefixed(contents),
    method: "s3_checksum_sha256",
    status: "provider_validated",
  });
  assert.equal(item?.status, "succeeded");
  assert.equal(input?.Bucket, "rakkr-archive");
  assert.equal(input?.ChecksumSHA256, sha256Base64(contents));
  assert.equal(input?.Key, "meetings/Council Meeting.mp3");
  assert.equal(input?.Metadata?.checksum, sha256Prefixed(contents));
  assert.equal(input?.Metadata?.recording_id, "rec_s3_ready_upload");
});

test("fails real provider upload when cached file checksum disagrees with metadata", async () => {
  const providerStore = createUploadProviderStore();
  const target = path.join(uploadRoot, "checksum-mismatch-share");

  await cacheRecording("rec_smb_checksum_mismatch", "actual-bytes");
  await providerStore.update("smb", {
    displayName: "Mismatch Share",
    enabled: true,
    target,
  });

  await enqueueRecordingUpload(
    {
      ...recording("rec_smb_checksum_mismatch"),
      checksum: sha256Prefixed("different-bytes"),
    },
    {
      maxAttempts: 1,
      provider: "smb",
    },
  );
  const result = await runUploadQueueOnce({ providerStore });

  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.items[0]?.reason, "source_checksum_mismatch");
});

function recording(id: string, contents?: string): RecordingSummary {
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
  const cachePath = path.join(uploadRoot, "cache", "scheduled", `${id}.mp3`);

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents);
}

function sha256Prefixed(contents: string) {
  return `sha256:${sha256Hex(contents)}`;
}

function sha256Base64(contents: string) {
  return Buffer.from(sha256Hex(contents), "hex").toString("base64");
}

function sha256Hex(contents: string) {
  return createHash("sha256").update(contents).digest("hex");
}
