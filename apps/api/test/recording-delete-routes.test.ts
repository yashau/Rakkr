import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecordingSummary } from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

const deleteRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-delete-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(deleteRoot, "chunks.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(deleteRoot, "cache");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { storeRecordingChunkFile } = await import("../src/recording-cache.js");
const { listRecordingChunksForRecording, recordingChunkId, upsertRecordingChunk } =
  await import("../src/recording-chunks.js");

test.after(async () => {
  await rm(deleteRoot, { force: true, recursive: true });
});

test("bulk recording delete uses scoped recording context for snapshots", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recordingStore = memoryRecordingStore([
    recording({
      folder: "Raw Hidden Folder",
      id: "rec_scoped_delete",
      name: "Raw Hidden Name",
      tags: ["raw-hidden"],
    }),
  ]);
  const scopedRecording = recording({
    folder: "Scoped Folder",
    id: "rec_scoped_delete",
    name: "Scoped Visible Name",
    tags: ["scoped-visible"],
  });
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser() }),
    currentUser,
    nodeStore: {},
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => [],
    scopedRecordings: async () => [scopedRecording],
    settingsStore: {},
  });

  const response = await app.request("/api/v1/recordings/bulk-delete", {
    body: JSON.stringify({ recordingIds: ["rec_scoped_delete"] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { data: RecordingSummary[] };
  const stored = await recordingStore.find("rec_scoped_delete");
  const [event] = await auditStore.list({ action: "recordings.bulk_delete.succeeded" });
  const before = event?.before as { recordings?: RecordingSummary[] } | undefined;

  assert.equal(response.status, 200);
  assert.equal(stored, undefined);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:delete");
  assert.equal(body.data[0]?.name, "Scoped Visible Name");
  assert.equal(body.data[0]?.folder, "Scoped Folder");
  assert.deepEqual(body.data[0]?.tags, ["scoped-visible"]);
  assert.equal(before?.recordings?.[0]?.name, "Scoped Visible Name");
  assert.equal(before?.recordings?.[0]?.folder, "Scoped Folder");
  assert.deepEqual(before?.recordings?.[0]?.tags, ["scoped-visible"]);
});

test("single recording delete rejects scoped snapshots missing from storage", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([]);
  const scopedRecording = recording({
    id: "rec_stale_delete",
    name: "Stale Scoped Recording",
  });
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser() }),
    currentUser,
    nodeStore: {},
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission([]),
    scopedNodes: async () => [],
    scopedRecordings: async () => [scopedRecording],
    settingsStore: {},
  });

  const response = await app.request("/api/v1/recordings/rec_stale_delete", {
    method: "DELETE",
  });
  const [event] = await auditStore.list({ action: "recordings.delete.failed" });

  assert.equal(response.status, 404);
  assert.equal(event?.reason, "recording_not_found");
  assert.equal(event?.target.id, "rec_stale_delete");
  assert.equal(event?.target.name, "Stale Scoped Recording");
});

test("G49: deleting a chunked recording removes its chunk cache files and rows", async () => {
  const auditStore = createAuditStore("");
  // A chunked recording is `cached` but carries no recording-level cachePath —
  // its files/rows live only on the chunks (mirrors markRecordingCachedFromChunks).
  const chunked = recording({
    cached: true,
    id: `rec_chunked_${randomUUID()}`,
    status: "cached",
  });
  const recordingStore = memoryRecordingStore([chunked]);

  const stored = await storeRecordingChunkFile(chunked, 1, {
    bytes: wavFile(),
    fileName: "part.wav",
    mimeType: "audio/wav",
  });
  await upsertRecordingChunk({
    cachePath: stored.cachePath,
    createdAt: "2026-06-18T12:00:00.000Z",
    durationSeconds: stored.durationSeconds,
    id: recordingChunkId(chunked.id, 1),
    index: 1,
    jobId: `job_${randomUUID()}`,
    offsetSeconds: 0,
    recordingId: chunked.id,
    status: "cached",
    total: 1,
  });
  assert.equal((await listRecordingChunksForRecording(chunked.id)).length, 1);

  const app = new Hono<AppBindings>();
  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser() }),
    currentUser,
    nodeStore: {},
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission([]),
    scopedNodes: async () => [],
    scopedRecordings: async () => [chunked],
    settingsStore: {},
  });

  const response = await app.request(`/api/v1/recordings/${chunked.id}`, { method: "DELETE" });
  const [event] = await auditStore.list({ action: "recordings.delete.succeeded" });
  const details = (event?.details ?? {}) as { cacheDeleted?: boolean };
  const remaining = await listRecordingChunksForRecording(chunked.id);

  // Pre-fix: the chunk file was never touched (cacheDeleted false) and the chunk
  // rows outlived the deleted recording.
  assert.equal(response.status, 204);
  assert.equal(details.cacheDeleted, true);
  assert.equal(remaining.length, 0);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    calls.push({
      action,
      permission,
      target: target ? await target(c) : undefined,
    });
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_recording_delete",
        name: "Recording Delete User",
        roles: ["operator"],
        type: "user",
      },
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
  };
}

function currentUser(): CurrentUser {
  return {
    email: "recording-delete@example.com",
    groups: [],
    id: "user_recording_delete",
    name: "Recording Delete User",
    permissions: ["recording:delete"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recording(input: Partial<RecordingSummary>): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: `rec_${randomUUID()}`,
    name: "Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: ["voice"],
    ...input,
  };
}

function wavFile() {
  const samples = [0, 12_000, -24_000, 6000];
  const data = Buffer.alloc(samples.length * 2);

  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}
