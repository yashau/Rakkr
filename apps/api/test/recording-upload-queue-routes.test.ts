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
const {
  enqueueRecordingUpload,
  failUploadQueueItem,
  listDueUploadQueueItems,
  listUploadQueueItems,
  retryUploadQueueItem,
  startUploadQueueItem,
  succeedUploadQueueItem,
} = await import("../src/upload-queue.js");

// Drive an enqueued item to a genuine terminal `failed` state: start() consumes
// an attempt, fail() marks it failed once the budget is exhausted (maxAttempts:1).
async function exhaustToFailed(itemId: string, reason: string) {
  await startUploadQueueItem(itemId);

  return failUploadQueueItem(itemId, reason);
}
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

test("single recording upload queue only operates on scoped recordings", async () => {
  const auditStore = createAuditStore("");
  const hidden = recording({ id: "rec_single_upload_hidden" });
  const recordingStore = memoryRecordingStore([
    recording({ id: "rec_single_upload_visible" }),
    hidden,
  ]);
  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore,
    visibleRecordingIds: ["rec_single_upload_visible"],
  });

  const response = await app.request(`/api/v1/recordings/${hidden.id}/upload-queue`, {
    body: JSON.stringify({ reason: "hidden_single_upload" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const queuedItems = await listUploadQueueItems();
  const [event] = await auditStore.list({ action: "recordings.upload_queue.enqueue.failed" });

  assert.equal(response.status, 404);
  assert.equal(
    queuedItems.some((item) => item.recordingId === hidden.id),
    false,
  );
  assert.equal(event?.reason, "recording_not_found");
  assert.equal(event?.target.id, hidden.id);
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

test("upload queue list filters visible items by status provider and recording", async () => {
  const auditStore = createAuditStore("");
  const visibleS3 = recording({ id: "rec_queue_filter_s3" });
  const visibleStub = recording({ id: "rec_queue_filter_stub" });
  const hiddenS3 = recording({ id: "rec_queue_filter_hidden" });
  const queuedS3 = await enqueueRecordingUpload(visibleS3, {
    provider: "s3",
    reason: "visible_s3_retrying",
    target: "s3://rakkr-route-test/visible",
  });
  await enqueueRecordingUpload(visibleStub, {
    provider: "stub",
    reason: "visible_stub_queued",
    target: "stub://queue-only",
  });
  const hiddenQueued = await enqueueRecordingUpload(hiddenS3, {
    provider: "s3",
    reason: "hidden_s3_retrying",
    target: "s3://rakkr-route-test/hidden",
  });

  await retryUploadQueueItem(queuedS3.id);
  await retryUploadQueueItem(hiddenQueued.id);

  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore: memoryRecordingStore([visibleS3, visibleStub, hiddenS3]),
    visibleRecordingIds: [visibleS3.id, visibleStub.id],
  });
  const params = new URLSearchParams({
    provider: "s3",
    recordingId: visibleS3.id,
    status: "retrying",
  });

  const response = await app.request(`/api/v1/upload-queue?${params}`);
  const body = (await response.json()) as { data: UploadQueueItem[] };
  const invalidResponse = await app.request("/api/v1/upload-queue?status=stuck");
  const [event] = await auditStore.list({ action: "recordings.upload_queue.read.succeeded" });

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((item) => item.recordingId),
    [visibleS3.id],
  );
  assert.equal(body.data[0]?.provider, "s3");
  assert.equal(body.data[0]?.status, "retrying");
  assert.equal(invalidResponse.status, 400);
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.target.type, "upload_queue");
  assert.equal(event?.details.filteredCount, 1);
  assert.equal(event?.details.provider, "s3");
  assert.equal(event?.details.recordingId, visibleS3.id);
  assert.equal(event?.details.status, "retrying");
});

test("upload queue list bounds the page size when no limit is given", async () => {
  const auditStore = createAuditStore("");
  const a = recording({ id: "rec_queue_bound_a" });
  const b = recording({ id: "rec_queue_bound_b" });
  await enqueueRecordingUpload(a, { provider: "stub", target: "stub://bound-a" });
  await enqueueRecordingUpload(b, { provider: "stub", target: "stub://bound-b" });

  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore: memoryRecordingStore([a, b]),
    visibleRecordingIds: [a.id, b.id],
  });

  const response = await app.request("/api/v1/upload-queue");
  const body = (await response.json()) as { meta: { limit?: number } };

  // Pre-fix an omitted limit returned every scoped row with no ceiling
  // (meta.limit was undefined); now it defaults to the page-policy limit.
  assert.equal(response.status, 200);
  assert.equal(body.meta.limit, 50);
});

test("upload queue item detail returns scoped recording context", async () => {
  const auditStore = createAuditStore("");
  const visibleRecording = recording({ id: "rec_queue_detail_visible" });
  const queued = await enqueueRecordingUpload(visibleRecording, {
    provider: "stub",
    reason: "detail_ready",
    target: "stub://detail",
  });
  const permissionCalls: PermissionCall[] = [];
  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls,
    recordingStore: memoryRecordingStore([visibleRecording]),
  });

  const response = await app.request(`/api/v1/upload-queue/${queued.id}`);
  const body = (await response.json()) as {
    data: { item: UploadQueueItem; links: { retry: string }; recording?: RecordingSummary };
  };
  const [event] = await auditStore.list({
    action: "recordings.upload_queue.detail.read.succeeded",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "recordings.upload_queue.detail.read",
    permission: "recording:read",
    target: { id: visibleRecording.id, type: "recording" },
  });
  assert.equal(body.data.item.id, queued.id);
  assert.equal(body.data.recording?.id, visibleRecording.id);
  assert.equal(body.data.links.retry, `/api/v1/upload-queue/${queued.id}/retry`);
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.target.id, visibleRecording.id);
  assert.equal(event?.target.type, "recording");
  assert.equal(event?.correlationIds?.uploadQueueItemId, queued.id);
  assert.equal(event?.details.status, "queued");
});

test("upload queue item detail audits hidden items as not found", async () => {
  const auditStore = createAuditStore("");
  const hiddenRecording = recording({ id: "rec_queue_detail_hidden" });
  const hidden = await enqueueRecordingUpload(hiddenRecording, {
    provider: "s3",
    reason: "hidden_detail",
    target: "s3://rakkr-route-test/hidden-detail",
  });
  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore: memoryRecordingStore([hiddenRecording]),
    visibleRecordingIds: [],
  });

  const response = await app.request(`/api/v1/upload-queue/${hidden.id}`);
  const [event] = await auditStore.list({
    action: "recordings.upload_queue.detail.read.failed",
  });

  assert.equal(response.status, 404);
  assert.equal(event?.outcome, "failed");
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.reason, "upload_queue_item_not_found");
  assert.equal(event?.target.id, hidden.id);
  assert.equal(event?.target.type, "upload_queue");
});

test("upload queue routes use scoped recording context for reads and controls", async () => {
  const auditStore = createAuditStore("");
  const scopedRecording = recording({
    id: "rec_queue_scoped_context",
    name: "Scoped Queue Recording",
    uploadPolicyId: "upload-policy-stub",
  });
  const rawStoreRecording = recording({
    cachePath: undefined,
    cached: false,
    id: scopedRecording.id,
    name: "Raw Store Recording",
    uploadPolicyId: "upload-policy-stub",
  });
  const failed = await enqueueRecordingUpload(scopedRecording, {
    maxAttempts: 1,
    provider: "s3",
    reason: "scoped_context_failed",
    target: "s3://rakkr-route-test/scoped-context",
  });
  await exhaustToFailed(failed.id, "scoped_context_failed");

  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore: memoryRecordingStore([rawStoreRecording]),
    scopedRecordingSnapshots: [scopedRecording],
  });

  const detailResponse = await app.request(`/api/v1/upload-queue/${failed.id}`);
  const detailBody = (await detailResponse.json()) as {
    data: { recording?: RecordingSummary };
  };
  const actionsResponse = await app.request(`/api/v1/upload-queue/${failed.id}/actions`);
  const actionsBody = (await actionsResponse.json()) as UploadQueueActionsResponse;
  const bulkResponse = await app.request("/api/v1/recordings/bulk-upload-queue", {
    body: JSON.stringify({
      reason: "scoped_bulk_upload",
      recordingIds: [scopedRecording.id],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const retryResponse = await app.request(`/api/v1/upload-queue/${failed.id}/retry`, {
    method: "POST",
  });
  const [retryEvent] = await auditStore.list({
    action: "recordings.upload_queue.retry.succeeded",
  });

  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.data.recording?.name, scopedRecording.name);
  assert.equal(actionsResponse.status, 200);
  assert.equal(actionsBody.data.actions.retry.enabled, true);
  assert.equal(bulkResponse.status, 201);
  assert.equal(retryResponse.status, 200);
  assert.equal(retryEvent?.target.name, scopedRecording.name);
});

test("upload queue item action summary returns retry readiness", async () => {
  const auditStore = createAuditStore("");
  const failedRecording = recording({ id: "rec_queue_actions_failed" });
  const queuedRecording = recording({ id: "rec_queue_actions_queued" });
  const failed = await enqueueRecordingUpload(failedRecording, {
    maxAttempts: 1,
    provider: "s3",
    reason: "terminal_failure",
    target: "s3://rakkr-route-test/actions",
  });
  const queued = await enqueueRecordingUpload(queuedRecording, {
    provider: "stub",
    reason: "still_queued",
    target: "stub://queued",
  });

  await exhaustToFailed(failed.id, "terminal_failure");

  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore: memoryRecordingStore([failedRecording, queuedRecording]),
  });
  const failedResponse = await app.request(`/api/v1/upload-queue/${failed.id}/actions`);
  const queuedResponse = await app.request(`/api/v1/upload-queue/${queued.id}/actions`);
  const failedBody = (await failedResponse.json()) as UploadQueueActionsResponse;
  const queuedBody = (await queuedResponse.json()) as UploadQueueActionsResponse;
  const actionEvents = await auditStore.list({
    action: "recordings.upload_queue.actions.read.succeeded",
  });
  const failedEvent = actionEvents.find(
    (event) => event.correlationIds?.uploadQueueItemId === failed.id,
  );

  assert.equal(failedResponse.status, 200);
  assert.equal(failedBody.data.actions.detail.enabled, true);
  assert.equal(failedBody.data.actions.retry.enabled, true);
  assert.equal(failedBody.data.actions.retry.href, `/api/v1/upload-queue/${failed.id}/retry`);
  assert.equal(queuedResponse.status, 200);
  assert.equal(queuedBody.data.actions.retry.enabled, false);
  assert.equal(queuedBody.data.actions.retry.reason, "upload_queue_item_not_retryable");
  assert.equal(actionEvents.length, 2);
  assert.equal(failedEvent?.permission, "recording:read");
  assert.equal(failedEvent?.target.id, failedRecording.id);
  assert.equal(failedEvent?.target.type, "recording");
  assert.equal(failedEvent?.details.recordingAvailable, true);
  assert.equal(failedEvent?.details.retryable, true);
  assert.equal(failedEvent?.details.status, "failed");
  assert.equal(failedEvent?.details.visibleActionCount, 2);
});

test("upload queue item action summary reports permission and visibility blockers", async () => {
  const auditStore = createAuditStore("");
  const visibleRecording = recording({ id: "rec_queue_action_readonly" });
  const hiddenRecording = recording({ id: "rec_queue_action_hidden" });
  const visible = await enqueueRecordingUpload(visibleRecording, {
    maxAttempts: 1,
    provider: "s3",
    reason: "readonly_failed",
    target: "s3://rakkr-route-test/readonly",
  });
  const hidden = await enqueueRecordingUpload(hiddenRecording, {
    maxAttempts: 1,
    provider: "s3",
    reason: "hidden_failed",
    target: "s3://rakkr-route-test/hidden",
  });

  await exhaustToFailed(visible.id, "readonly_failed");
  await exhaustToFailed(hidden.id, "hidden_failed");

  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    permissions: ["recording:read"],
    recordingStore: memoryRecordingStore([visibleRecording, hiddenRecording]),
    visibleRecordingIds: [visibleRecording.id],
  });

  const visibleResponse = await app.request(`/api/v1/upload-queue/${visible.id}/actions`);
  const hiddenResponse = await app.request(`/api/v1/upload-queue/${hidden.id}/actions`);
  const visibleBody = (await visibleResponse.json()) as UploadQueueActionsResponse;
  const [succeededEvent] = await auditStore.list({
    action: "recordings.upload_queue.actions.read.succeeded",
  });
  const [failedEvent] = await auditStore.list({
    action: "recordings.upload_queue.actions.read.failed",
  });

  assert.equal(visibleResponse.status, 200);
  assert.equal(visibleBody.data.actions.retry.enabled, false);
  assert.equal(visibleBody.data.actions.retry.reason, "missing_permission");
  assert.equal(hiddenResponse.status, 404);
  assert.equal(succeededEvent?.target.id, visibleRecording.id);
  assert.equal(succeededEvent?.details.retryable, true);
  assert.equal(failedEvent?.permission, "recording:read");
  assert.equal(failedEvent?.reason, "upload_queue_item_not_found");
  assert.equal(failedEvent?.target.id, hidden.id);
  assert.equal(failedEvent?.target.type, "upload_queue");
});

test("upload queue retry audits items outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const hiddenRecording = recording({ id: "rec_retry_hidden" });
  const queued = await enqueueRecordingUpload(hiddenRecording, {
    provider: "s3",
    reason: "manual_retry_hidden",
    target: "s3://rakkr-route-test/hidden",
  });
  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore: memoryRecordingStore([hiddenRecording]),
    visibleRecordingIds: [],
  });

  const response = await app.request(`/api/v1/upload-queue/${queued.id}/retry`, {
    method: "POST",
  });
  const [event] = await auditStore.list({
    action: "recordings.upload_queue.retry.failed",
  });

  assert.equal(response.status, 404);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "upload_queue_item_not_visible");
  assert.equal(event?.target.id, "rec_retry_hidden");
  assert.equal(event?.correlationIds?.uploadQueueItemId, queued.id);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

interface UploadQueueActionsResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; reason?: string }>;
  };
}

test("operator retry revives a terminally-failed upload item so the runner re-attempts it", async () => {
  const rec = recording({ id: "rec_queue_retry_revive" });
  const item = await enqueueRecordingUpload(rec, {
    maxAttempts: 1,
    provider: "s3",
    reason: "revive_failed",
    target: "s3://rakkr-route-test/revive",
  });
  const failed = await exhaustToFailed(item.id, "revive_failed");

  assert.equal(failed?.status, "failed");

  const retried = await retryUploadQueueItem(item.id);
  const due = await listDueUploadQueueItems();

  // Pre-fix: retry() incremented the already-maxed attemptCount, so the item
  // stayed "failed" and the runner (dueStatuses = queued|retrying) never
  // re-attempted it. Now it returns to "retrying" with a fresh budget, due now.
  assert.equal(retried?.status, "retrying");
  assert.equal(retried?.attemptCount, 0);
  assert.ok(
    due.some((entry) => entry.id === item.id),
    "the retried item must be due for the runner",
  );
});

test("retry route rejects a non-retryable (succeeded) item server-side", async () => {
  const auditStore = createAuditStore("");
  const rec = recording({ id: "rec_queue_retry_guard" });
  const item = await enqueueRecordingUpload(rec, { provider: "stub", target: "stub://guard" });
  await startUploadQueueItem(item.id);
  await succeedUploadQueueItem(item.id);

  const app = recordingUploadQueueApp({
    auditStore,
    permissionCalls: [],
    recordingStore: memoryRecordingStore([rec]),
    visibleRecordingIds: [rec.id],
  });

  const response = await app.request(`/api/v1/upload-queue/${item.id}/retry`, { method: "POST" });
  const stored = (await listUploadQueueItems()).find((entry) => entry.id === item.id);
  const [event] = await auditStore.list({ action: "recordings.upload_queue.retry.failed" });

  // Pre-fix: the route reset a succeeded item to retrying (UI-only guard),
  // which could demote an uploaded recording to partial. It must be rejected
  // server-side, leaving the item succeeded.
  assert.equal(response.status, 409);
  assert.equal(stored?.status, "succeeded");
  assert.equal(event?.reason, "upload_queue_item_not_retryable");
});

function recordingUploadQueueApp({
  auditStore,
  permissionCalls,
  permissions,
  recordingStore,
  scopedRecordingSnapshots,
  visibleRecordingIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  permissionCalls: PermissionCall[];
  permissions?: Permission[];
  recordingStore: RecordingStore;
  scopedRecordingSnapshots?: RecordingSummary[];
  visibleRecordingIds?: string[];
}) {
  const app = new Hono<AppBindings>();
  const currentUser = user(permissions);

  registerRecordingUploadQueueRoutes({
    app,
    currentAuth: () => auth(currentUser),
    currentUser: () => currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: requirePermission(permissionCalls),
    scopedRecordings: async () => {
      const recordings = scopedRecordingSnapshots ?? (await recordingStore.list());

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

function auth(currentUser = user()): AuthResult {
  return { user: currentUser };
}

function user(permissions: Permission[] = ["recording:control", "recording:read"]): CurrentUser {
  return {
    email: "recording-upload-queue-route@example.com",
    groups: [],
    id: "user_recording_upload_queue_route",
    name: "Recording Upload Queue Route User",
    permissions,
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
