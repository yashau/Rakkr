import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

process.env.DATABASE_URL = "";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

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
