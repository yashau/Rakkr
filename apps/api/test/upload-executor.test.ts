import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const uploadRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-executor-"));
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(uploadRoot, "cache");
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(uploadRoot, "destinations.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(uploadRoot, "queue.json");

const { createUploadDestinationStore } = await import("../src/upload-destinations.js");
const { runUploadQueueOnce } = await import("../src/upload-executor.js");
const { enqueueRecordingUpload, listUploadQueueItems, startUploadQueueItem } =
  await import("../src/upload-queue.js");

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

test("skips in-flight upload items until their recovery lease expires", async () => {
  const startedAt = new Date("2026-06-18T12:00:00.000Z");
  const beforeLeaseExpiry = new Date("2026-06-18T12:14:59.000Z");
  const afterLeaseExpiry = new Date("2026-06-18T12:15:00.000Z");
  const queued = await enqueueRecordingUpload(recording("rec_stub_upload_lease"), {
    provider: "stub",
    target: "stub://queue-only",
  });

  await startUploadQueueItem(queued.id, startedAt);

  const deferred = await runUploadQueueOnce({ limit: 5, now: beforeLeaseExpiry });
  const recovered = await runUploadQueueOnce({ limit: 5, now: afterLeaseExpiry });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);

  assert.equal(deferred.attempted, 0);
  assert.equal(recovered.attempted, 1);
  assert.equal(recovered.succeeded, 1);
  assert.equal(item?.attemptCount, 2);
  assert.equal(item?.status, "succeeded");
});

test("defers provider failures until the retry budget is exhausted", async () => {
  const destinationStore = createUploadDestinationStore();

  // Enabled but missing the secret access key -> not configured.
  const destination = await destinationStore.create({
    displayName: "Archive S3",
    enabled: true,
    kind: "s3",
    s3: {
      accessKeyId: "AKIAEXAMPLE",
      bucket: "rakkr-archive",
      prefix: "meetings",
      region: "us-east-1",
    },
  });

  const queued = await enqueueRecordingUpload(recording("rec_s3_upload"), {
    destinationId: destination.id,
    maxAttempts: 1,
    provider: "s3",
  });
  const result = await runUploadQueueOnce({ destinationStore });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);

  assert.equal(result.attempted, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.items[0]?.reason, "missing_s3.secretAccessKey");
  assert.equal(item?.attemptCount, 1);
  assert.equal(item?.lastError, "missing_s3.secretAccessKey");
  assert.equal(item?.status, "failed");
});

test("uploads SMB queue items directly to the share over the network", async () => {
  const destinationStore = createUploadDestinationStore();
  const smb = fakeSmbClient();
  const contents = "smb-bytes";

  await cacheRecording("rec_smb_upload", contents);
  const destination = await destinationStore.create({
    displayName: "Recordings Share",
    enabled: true,
    kind: "smb",
    smb: {
      path: "meetings/2026",
      server: "files.example.lan",
      share: "recordings",
      username: "svc",
    },
    smbPassword: "s3cr3t",
  });

  const queued = await enqueueRecordingUpload(recording("rec_smb_upload", contents), {
    destinationId: destination.id,
    maxAttempts: 1,
    provider: "smb",
  });
  const result = await runUploadQueueOnce({ destinationStore, smbClientFactory: () => smb.client });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);

  assert.equal(result.succeeded, 1);
  assert.deepEqual(result.items[0]?.checksumVerification, {
    algorithm: "sha256",
    expected: sha256Prefixed(contents),
    method: "file_copy_sha256",
    observed: sha256Prefixed(contents),
    status: "matched",
  });
  assert.equal(item?.status, "succeeded");
  // Share is the first path segment; nested dirs are created before writing.
  assert.equal(
    smb.files.get("recordings/meetings/2026/Council Meeting.mp3")?.toString("utf8"),
    "smb-bytes",
  );
  assert.deepEqual(smb.dirs, ["recordings/meetings", "recordings/meetings/2026"]);
});

test("uploads S3 queue items with explicit credentials, bucket, key, and metadata", async () => {
  const destinationStore = createUploadDestinationStore();
  const sentCommands = [];
  const contents = "s3-bytes";

  await cacheRecording("rec_s3_ready_upload", contents);
  const destination = await destinationStore.create({
    displayName: "Archive S3",
    enabled: true,
    kind: "s3",
    s3: {
      accessKeyId: "AKIAEXAMPLE",
      bucket: "rakkr-archive",
      prefix: "meetings",
      region: "us-east-1",
    },
    s3SecretAccessKey: "s3-secret",
  });

  // pathOverride is appended to the destination prefix in the object key.
  const queued = await enqueueRecordingUpload(recording("rec_s3_ready_upload", contents), {
    destinationId: destination.id,
    maxAttempts: 1,
    pathOverride: "council",
    provider: "s3",
  });
  const result = await runUploadQueueOnce({
    destinationStore,
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
  assert.equal(input?.Key, "meetings/council/Council Meeting.mp3");
  assert.equal(input?.Metadata?.checksum, sha256Prefixed(contents));
  assert.equal(input?.Metadata?.recording_id, "rec_s3_ready_upload");
});

test("G-NEW: S3 object key strips pathOverride traversal so it cannot escape the prefix", async () => {
  const destinationStore = createUploadDestinationStore();
  const sentCommands = [];
  const contents = "s3-escape-bytes";

  await cacheRecording("rec_s3_escape", contents);
  const destination = await destinationStore.create({
    displayName: "Archive S3",
    enabled: true,
    kind: "s3",
    s3: {
      accessKeyId: "AKIAEXAMPLE",
      bucket: "rakkr-archive",
      prefix: "meetings",
      region: "us-east-1",
    },
    s3SecretAccessKey: "s3-secret",
  });
  const queued = await enqueueRecordingUpload(recording("rec_s3_escape", contents), {
    destinationId: destination.id,
    maxAttempts: 1,
    pathOverride: "../../escape",
    provider: "s3",
  });
  const result = await runUploadQueueOnce({
    destinationStore,
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
  // Pre-fix `path.posix.join` resolved `..` -> "../escape/Council Meeting.mp3",
  // escaping the configured prefix; traversal segments are now dropped so the
  // key stays contained under the prefix.
  assert.equal(input?.Key, "meetings/escape/Council Meeting.mp3");
  assert.ok(!input?.Key.includes(".."));
  assert.ok(input?.Key.startsWith("meetings/"));
});

test("G58: S3 upload to a custom endpoint reports provider_declared, not provider_validated", async () => {
  const destinationStore = createUploadDestinationStore();
  const contents = "s3-endpoint-bytes";

  await cacheRecording("rec_s3_endpoint_upload", contents);
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
  const queued = await enqueueRecordingUpload(recording("rec_s3_endpoint_upload", contents), {
    destinationId: destination.id,
    maxAttempts: 1,
    provider: "s3",
  });
  const result = await runUploadQueueOnce({
    destinationStore,
    s3Client: {
      async send() {},
    },
  });
  const item = (await listUploadQueueItems()).find((candidate) => candidate.id === queued.id);

  assert.equal(result.succeeded, 1);
  // A custom S3-compatible endpoint may silently ignore ChecksumSHA256, so we
  // don't overstate the audit trail with provider_validated.
  assert.equal(result.items[0]?.checksumVerification?.status, "provider_declared");
  assert.equal(item?.status, "succeeded");
});

test("fails real provider upload when cached file checksum disagrees with metadata", async () => {
  const destinationStore = createUploadDestinationStore();

  await cacheRecording("rec_smb_checksum_mismatch", "actual-bytes");
  const destination = await destinationStore.create({
    displayName: "Recordings Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });

  await enqueueRecordingUpload(
    {
      ...recording("rec_smb_checksum_mismatch"),
      checksum: sha256Prefixed("different-bytes"),
    },
    {
      destinationId: destination.id,
      maxAttempts: 1,
      provider: "smb",
    },
  );
  const result = await runUploadQueueOnce({
    destinationStore,
    smbClientFactory: () => {
      throw new Error("smb_client_should_not_be_used");
    },
  });

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

function fakeSmbClient() {
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];

  return {
    client: {
      async close() {},
      async connect() {},
      async mkdir(targetPath: string) {
        dirs.push(targetPath);
      },
      async readFile(targetPath: string) {
        const data = files.get(targetPath);

        if (!data) {
          const error = new Error("ENOENT") as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        }

        return data;
      },
      async writeFile(targetPath: string, data: Buffer | string) {
        files.set(targetPath, Buffer.from(data));
      },
    },
    dirs,
    files,
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
