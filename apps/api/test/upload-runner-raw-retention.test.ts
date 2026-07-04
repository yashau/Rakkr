import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";
import { memoryRecordingStore } from "./recording-store-mock.js";

// Self-contained harness (kept out of the large upload-runner.test.ts to stay under
// the LOC guard). Env must be set before importing the stores so they use this
// temp cache/store layout.
const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-raw-retention-"));
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

test("upload runner preserves the never-uploaded raw master when deleting cache after upload", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "enhanced-primary-bytes";
  const id = "rec_upload_raw_preserve";
  const rawRel = `scheduled/${id}.raw.mp3`;
  // The enhanced primary is uploaded; the raw master is supplementary (kept in the
  // controller cache, never enqueued for external upload).
  const cachedRecording = { ...recording(id, contents), rawCachePath: rawRel };
  const cachePath = await cacheRecording(id, contents);
  const rawCachePath = path.join(runnerRoot, "cache", "scheduled", `${id}.raw.mp3`);
  await writeFile(rawCachePath, "raw-master-bytes");
  const recordingStore = memoryRecordingStore([cachedRecording]);
  const smb = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    limit: 5,
    destinationStore,
    recordingStore,
    smbClientFactory: () => smb.client,
  });

  const destination = await destinationStore.create({
    displayName: "Archive Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const policy = await createUploadPolicy({
    deleteCacheAfterUpload: true,
    destinationId: destination.id,
    enabled: true,
    maxAttempts: 1,
    name: "Archive then delete cache",
    trigger: "manual",
  });
  await enqueueRecordingUpload(cachedRecording, {
    destinationId: destination.id,
    maxAttempts: 1,
    policyId: policy.id,
    provider: "smb",
  });

  const summary = await runner.runOnce();

  assert.equal(summary.succeeded, 1);
  // The uploaded primary is reclaimed...
  await assert.rejects(readFile(cachePath), /ENOENT/);
  // ...but the raw master (never uploaded, the documented source of truth) survives.
  assert.equal((await readFile(rawCachePath)).toString("utf8"), "raw-master-bytes");
});

function recording(id: string, contents: string): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    checksum: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
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
