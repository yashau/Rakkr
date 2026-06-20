import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-retention-runner-"));
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(runnerRoot, "cache");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(runnerRoot, "policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createRetentionPolicy } = await import("../src/retention-policies.js");
const { createRetentionRunner } = await import("../src/retention-runner.js");

test.after(async () => {
  await rm(runnerRoot, { force: true, recursive: true });
});

test("retention runner deletes stale controller cache and audits the lifecycle", async () => {
  const auditStore = createAuditStore("");
  const policy = await createRetentionPolicy({
    action: "delete_cache",
    deleteOnlyAfterUploaded: false,
    maxAgeDays: 14,
    name: "Delete stale controller cache",
    preserveTagged: false,
    scope: "controller_cache",
  });
  const staleRecording = recording({
    id: "rec_retention_stale",
    recordedAt: "2026-05-01T12:00:00.000Z",
    retentionPolicyId: policy.id,
  });
  const freshRecording = recording({
    id: "rec_retention_fresh",
    recordedAt: "2026-06-19T12:00:00.000Z",
    retentionPolicyId: policy.id,
  });
  const stalePath = await cacheRecording(staleRecording, "stale-bytes");
  const freshPath = await cacheRecording(freshRecording, "fresh-bytes");
  const recordingStore = memoryRecordingStore([staleRecording, freshRecording]);
  const runner = createRetentionRunner({ auditStore, recordingStore });

  const summary = await runner.runOnce(new Date("2026-06-20T12:00:00.000Z"));
  const stale = await recordingStore.find(staleRecording.id);
  const fresh = await recordingStore.find(freshRecording.id);
  const itemEvents = await auditStore.list({ action: "recordings.retention.cache_deleted" });
  const runEvents = await auditStore.list({ action: "recordings.retention.runner.completed" });

  assert.equal(summary.deleted, 1);
  assert.equal(summary.items[0]?.policyId, policy.id);
  await assert.rejects(readFile(stalePath), /ENOENT/);
  assert.equal(await readFile(freshPath, "utf8"), "fresh-bytes");
  assert.equal(stale?.cached, false);
  assert.equal(stale?.cachePath, undefined);
  assert.equal(stale?.status, "completed");
  assert.equal(fresh?.cached, true);
  assert.equal(itemEvents[0]?.actor.id, "system:retention-runner");
  assert.equal(itemEvents[0]?.details.reason, "max_age");
  assert.equal(runEvents[0]?.details.deleted, 1);
});

test("retention runner trims oldest uploaded cache when max bytes is exceeded", async () => {
  const auditStore = createAuditStore("");
  const policy = await createRetentionPolicy({
    action: "delete_cache",
    deleteOnlyAfterUploaded: true,
    maxBytes: "older-cache".length,
    name: "Limit controller cache bytes",
    preserveTagged: false,
    scope: "controller_cache",
  });
  const oldest = recording({
    id: "rec_retention_oldest",
    recordedAt: "2026-06-19T12:00:00.000Z",
    retentionPolicyId: policy.id,
    status: "uploaded",
  });
  const newest = recording({
    id: "rec_retention_newest",
    recordedAt: "2026-06-20T00:00:00.000Z",
    retentionPolicyId: policy.id,
    status: "uploaded",
  });
  const oldestPath = await cacheRecording(oldest, "older-cache");
  const newestPath = await cacheRecording(newest, "new-cache");
  const recordingStore = memoryRecordingStore([newest, oldest]);
  const runner = createRetentionRunner({ auditStore, recordingStore });

  const summary = await runner.runOnce(new Date("2026-06-20T12:00:00.000Z"));
  const oldestUpdated = await recordingStore.find(oldest.id);
  const newestUpdated = await recordingStore.find(newest.id);

  assert.equal(summary.deleted, 1);
  assert.equal(summary.items[0]?.reason, "max_bytes");
  await assert.rejects(readFile(oldestPath), /ENOENT/);
  assert.equal(await readFile(newestPath, "utf8"), "new-cache");
  assert.equal(oldestUpdated?.status, "uploaded");
  assert.equal(oldestUpdated?.cachePath, undefined);
  assert.equal(newestUpdated?.cachePath, newest.cachePath);
});

function recording({
  id,
  recordedAt,
  retentionPolicyId,
  status = "cached",
}: {
  id: string;
  recordedAt: string;
  retentionPolicyId: string;
  status?: RecordingSummary["status"];
}): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id,
    name: id,
    recordedAt,
    retentionPolicyId,
    source: "schedule",
    status,
    tags: [],
  };
}

function memoryRecordingStore(recordings: RecordingSummary[]) {
  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
    async delete(recordingId: string) {
      const index = recordings.findIndex((recording) => recording.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId: string) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording: RecordingSummary) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
  };
}

async function cacheRecording(recording: RecordingSummary, contents: string) {
  const cachePath = path.join(
    process.env.RAKKR_RECORDING_CACHE_DIR ?? "",
    recording.cachePath ?? "",
  );

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents);

  return cachePath;
}
