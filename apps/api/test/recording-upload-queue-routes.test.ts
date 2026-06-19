import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecordingSummary,
  UploadQueueItem,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-upload-queue-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(routeRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingUploadQueueRoutes } =
  await import("../src/recording-upload-queue-routes.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("single recording upload queue enqueues cached recordings after route extraction", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([recording({ id: "rec_single_upload_queue" })]);
  const permissionCalls: PermissionCall[] = [];
  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings/rec_single_upload_queue/upload-queue", {
    body: JSON.stringify({ reason: "manual_route_test" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { data: UploadQueueItem };
  const [event] = await auditStore.list({ action: "recordings.upload_queue.enqueue.succeeded" });

  assert.equal(response.status, 201);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:control");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.upload_queue.enqueue");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "rec_single_upload_queue",
    type: "recording",
  });
  assert.equal(body.data.recordingId, "rec_single_upload_queue");
  assert.equal(body.data.lastError, "manual_route_test");
  assert.equal(event?.target.id, "rec_single_upload_queue");
});

test("bulk upload queue enqueues visible cached recordings and audits collection", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({ id: "rec_bulk_upload_a" }),
    recording({ id: "rec_bulk_upload_b" }),
    recording({ id: "rec_bulk_upload_keep" }),
  ]);
  const permissionCalls: PermissionCall[] = [];
  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings/bulk-upload-queue", {
    body: JSON.stringify({
      reason: "manual_bulk_upload",
      recordingIds: ["rec_bulk_upload_a", "rec_bulk_upload_b", "rec_bulk_upload_a"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as {
    data: UploadQueueItem[];
    meta: { queuedCount: number };
  };
  const [event] = await auditStore.list({
    action: "recordings.upload_queue.bulk_enqueue.succeeded",
  });

  assert.equal(response.status, 201);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:control");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.upload_queue.bulk_enqueue");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "recording_collection",
    type: "recording_collection",
  });
  assert.equal(body.meta.queuedCount, 2);
  assert.deepEqual(
    body.data.map((item) => item.recordingId),
    ["rec_bulk_upload_a", "rec_bulk_upload_b"],
  );
  assert.equal(event?.permission, "recording:control");
  assert.equal(event?.target.type, "recording_collection");
  assert.equal(event?.details.queuedCount, 2);
  assert.equal(event?.details.requestedCount, 3);
});

test("bulk upload queue rejects recordings outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({ id: "rec_bulk_upload_visible" }),
    recording({ id: "rec_bulk_upload_hidden" }),
  ]);
  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore,
    visibleRecordingIds: ["rec_bulk_upload_visible"],
  });

  const response = await app.request("/api/v1/recordings/bulk-upload-queue", {
    body: JSON.stringify({
      recordingIds: ["rec_bulk_upload_visible", "rec_bulk_upload_hidden"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({
    action: "recordings.upload_queue.bulk_enqueue.failed",
  });

  assert.equal(response.status, 404);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "recording_not_visible");
  assert.deepEqual(event?.details.hiddenIds, ["rec_bulk_upload_hidden"]);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function recordingUploadQueueApp({
  auditStore,
  permissionCalls,
  recordingStore,
  visibleRecordingIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  permissionCalls: PermissionCall[];
  recordingStore: RecordingStore;
  visibleRecordingIds?: string[];
}) {
  const app = new Hono<AppBindings>();

  registerRecordingUploadQueueRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedRecordings: async () => {
      const recordings = await recordingStore.list();

      return visibleRecordingIds
        ? recordings.filter((recording) => visibleRecordingIds.includes(recording.id))
        : recordings;
    },
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => {
    return async (c, next) => {
      calls.push({
        action,
        permission,
        target: target ? await target(c) : undefined,
      });
      await next();
    };
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: "user_recording_upload_queue_route",
        name: "Recording Upload Queue Route User",
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

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((recording) => recording.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((recording) => recording.id === recordingId);
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

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "recording-upload-queue-route@example.com",
    groups: [],
    id: "user_recording_upload_queue_route",
    name: "Recording Upload Queue Route User",
    permissions: ["recording:control"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recording(input: Partial<RecordingSummary>): RecordingSummary {
  return {
    cachePath: `${input.id ?? "rec_upload_queue"}.mp3`,
    cached: true,
    checksum: "sha256:test",
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: `rec_${randomUUID()}`,
    name: "Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "cached",
    tags: ["voice"],
    ...input,
  };
}
