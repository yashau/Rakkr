import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  HealthEvent,
  Permission,
  RecordingSummary,
} from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { registerHealthRoutes } = await import("../src/health-routes.js");

test("health routes deny users without required permissions", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user([]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: denyMissingPermission(auditStore, currentUser),
  });

  const responses = await Promise.all([
    app.request("/api/v1/health-events"),
    app.request("/api/v1/health-events/export"),
    app.request("/api/v1/health-events/health_denied"),
    app.request("/api/v1/health-events/health_denied/actions"),
    requestJson(app, "/api/v1/health-events/export", "POST", {
      eventIds: ["health_denied"],
    }),
    requestJson(app, "/api/v1/health-events", "POST", {
      nodeId: "node_health_denied",
      severity: "warning",
      type: "test.low_signal",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/acknowledge", "POST", {
      note: "blocked",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/suppress", "POST", {
      note: "blocked",
      suppressedUntil: "2026-06-19T13:00:00.000Z",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/resolve", "POST", {
      note: "blocked",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/reopen", "POST", {
      note: "blocked",
    }),
    requestJson(app, "/api/v1/health-events/bulk-lifecycle", "POST", {
      action: "acknowledge",
      eventIds: ["health_denied"],
      note: "blocked",
    }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => `${event.permission}:${event.action}`).sort(), [
    "health:acknowledge:health.events.acknowledge",
    "health:acknowledge:health.events.bulk_lifecycle",
    "health:acknowledge:health.events.create",
    "health:acknowledge:health.events.reopen",
    "health:acknowledge:health.events.resolve",
    "health:acknowledge:health.events.suppress",
    "health:read:health.events.actions.read",
    "health:read:health.events.detail.read",
    "health:read:health.events.export",
    "health:read:health.events.export_selected",
    "health:read:health.events.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === currentUser.id));
});

test("health event detail returns only visible scoped events", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["health:read"]);
  const visible = event({
    details: { rmsDbfs: -41 },
    id: "health_visible_detail",
    nodeId: "node_1",
    severity: "critical",
    type: "watchdog.scheduled_low_signal",
  });
  const hidden = event({ id: "health_hidden_detail", nodeId: "node_hidden" });
  const permissionCalls: PermissionCall[] = [];

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async (_user, target) => target.id !== "node_hidden",
    healthEventStore: createHealthEventStore("", [visible, hidden]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: allowPermissionWithCalls(permissionCalls),
  });

  const visibleResponse = await app.request(`/api/v1/health-events/${visible.id}`);
  const hiddenResponse = await app.request(`/api/v1/health-events/${hidden.id}`);
  const missingResponse = await app.request("/api/v1/health-events/health_missing_detail");
  const visibleBody = (await visibleResponse.json()) as { data: HealthEvent };
  const successEvents = await auditStore.list({
    action: "health.events.detail.read.succeeded",
  });
  const failedEvents = await auditStore.list({
    action: "health.events.detail.read.failed",
  });

  assert.equal(visibleResponse.status, 200);
  assert.equal(visibleBody.data.id, visible.id);
  assert.equal(visibleBody.data.details.rmsDbfs, -41);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(permissionCalls.at(-3), {
    action: "health.events.detail.read",
    permission: "health:read",
    target: { id: visible.id, type: "health_event" },
  });
  assert.deepEqual(permissionCalls.at(-2), {
    action: "health.events.detail.read",
    permission: "health:read",
    target: { id: hidden.id, type: "health_event" },
  });
  assert.deepEqual(permissionCalls.at(-1), {
    action: "health.events.detail.read",
    permission: "health:read",
    target: { id: "health_missing_detail", type: "health_event" },
  });
  assert.equal(successEvents.length, 1);
  assert.equal(successEvents[0]?.permission, "health:read");
  assert.equal(successEvents[0]?.target.id, visible.id);
  assert.deepEqual(successEvents[0]?.details, {
    hasNode: true,
    hasRecording: false,
    hasSchedule: false,
    severity: "critical",
    status: "open",
    type: "watchdog.scheduled_low_signal",
  });
  assert.deepEqual(
    failedEvents.map((auditEvent) => auditEvent.reason),
    ["health_event_not_found", "health_event_not_found"],
  );
  assert.deepEqual(failedEvents.map((auditEvent) => auditEvent.target.id).sort(), [
    hidden.id,
    "health_missing_detail",
  ]);
  assert.ok(failedEvents.every((auditEvent) => auditEvent.permission === "health:read"));
});

test("health event list returns scoped filtered events and audits access", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["health:read"]);
  const healthEventStore = createHealthEventStore("", [
    event({
      id: "health_visible_list",
      nodeId: "node_1",
      openedAt: "2026-06-20T12:00:00.000Z",
      severity: "critical",
      status: "open",
      type: "watchdog.scheduled_low_signal",
    }),
    event({
      id: "health_filtered_list",
      nodeId: "node_1",
      severity: "warning",
      status: "open",
      type: "watchdog.node_offline",
    }),
    event({
      id: "health_hidden_list",
      nodeId: "node_hidden",
      severity: "critical",
      status: "open",
      type: "watchdog.scheduled_low_signal",
    }),
  ]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async (_user, target) => target.id !== "node_hidden",
    healthEventStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: allowPermission,
  });

  const response = await app.request(
    "/api/v1/health-events?severity=critical&type=watchdog.scheduled_low_signal&openedFrom=2026-06-20T00:00:00.000Z&openedTo=2026-06-20T23:59:59.999Z",
  );
  const body = (await response.json()) as { data: HealthEvent[] };
  const invalidResponse = await app.request("/api/v1/health-events?severity=catastrophic");
  const [successEvent] = await auditStore.list({ action: "health.events.read.succeeded" });
  const [failedEvent] = await auditStore.list({ action: "health.events.read.failed" });

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((healthEvent) => healthEvent.id),
    ["health_visible_list"],
  );
  assert.equal(invalidResponse.status, 400);
  assert.equal(successEvent?.permission, "health:read");
  assert.equal(successEvent?.target.type, "health");
  assert.equal(successEvent?.details.returnedCount, 1);
  assert.deepEqual(successEvent?.details.filters, {
    limit: undefined,
    nodeId: undefined,
    openedFrom: new Date("2026-06-20T00:00:00.000Z"),
    openedTo: new Date("2026-06-20T23:59:59.999Z"),
    recordingId: undefined,
    resolvedFrom: undefined,
    resolvedTo: undefined,
    scheduleId: undefined,
    search: undefined,
    severity: "critical",
    status: undefined,
    type: "watchdog.scheduled_low_signal",
  });
  assert.equal(failedEvent?.outcome, "failed");
  assert.equal(failedEvent?.permission, "health:read");
  assert.equal(failedEvent?.reason, "invalid_filters");
  assert.equal(failedEvent?.target.type, "health");
  assert.equal(failedEvent?.details.issues, 1);
});

test("health event export returns scoped filtered csv and audits access", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["health:read"]);
  const healthEventStore = createHealthEventStore("", [
    event({
      details: { dbfs: -72, reason: "too quiet" },
      id: "health_visible",
      nodeId: "node_1",
      openedAt: "2026-06-20T12:00:00.000Z",
      resolvedAt: "2026-06-20T16:00:00.000Z",
      severity: "critical",
      status: "resolved",
      type: "watchdog.scheduled_low_signal",
    }),
    event({
      id: "health_filtered",
      nodeId: "node_1",
      severity: "warning",
      status: "open",
      type: "watchdog.node_offline",
    }),
    event({
      id: "health_too_old",
      nodeId: "node_1",
      openedAt: "2026-06-19T23:59:59.999Z",
      severity: "critical",
      status: "open",
      type: "watchdog.scheduled_low_signal",
    }),
    event({
      id: "health_too_new",
      nodeId: "node_1",
      openedAt: "2026-06-21T00:00:00.000Z",
      severity: "critical",
      status: "open",
      type: "watchdog.scheduled_low_signal",
    }),
    event({
      id: "health_hidden",
      nodeId: "node_hidden",
      openedAt: "2026-06-20T14:00:00.000Z",
      severity: "critical",
      status: "open",
      type: "watchdog.scheduled_low_signal",
    }),
  ]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async (_user, target) => target.id !== "node_hidden",
    healthEventStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: allowPermission,
  });

  const response = await app.request(
    "/api/v1/health-events/export?severity=critical&type=watchdog.scheduled_low_signal&search=too%20quiet&openedFrom=2026-06-20T00:00:00.000Z&openedTo=2026-06-20T23:59:59.999Z&resolvedFrom=2026-06-20T00:00:00.000Z&resolvedTo=2026-06-20T23:59:59.999Z",
  );
  const csv = await response.text();
  const [auditEvent] = await auditStore.list({ action: "health.events.export.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="rakkr-health-events-/,
  );
  assert.match(csv, /^"id","type","severity","status","nodeId"/m);
  assert.match(csv, /"health_visible","watchdog\.scheduled_low_signal","critical","resolved"/);
  assert.match(csv, /"\{""dbfs"":-72,""reason"":""too quiet""\}"/);
  assert.doesNotMatch(csv, /health_filtered/);
  assert.doesNotMatch(csv, /health_too_old/);
  assert.doesNotMatch(csv, /health_too_new/);
  assert.doesNotMatch(csv, /health_hidden/);
  assert.equal(auditEvent?.permission, "health:read");
  assert.equal(auditEvent?.details.exportedCount, 1);
  assert.deepEqual(auditEvent?.details.filters, {
    limit: undefined,
    nodeId: undefined,
    openedFrom: new Date("2026-06-20T00:00:00.000Z"),
    openedTo: new Date("2026-06-20T23:59:59.999Z"),
    recordingId: undefined,
    resolvedFrom: new Date("2026-06-20T00:00:00.000Z"),
    resolvedTo: new Date("2026-06-20T23:59:59.999Z"),
    scheduleId: undefined,
    search: "too quiet",
    severity: "critical",
    status: undefined,
    type: "watchdog.scheduled_low_signal",
  });
});

test("selected health event export preserves requested order and audits access", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["health:read"]);
  const healthEventStore = createHealthEventStore("", [
    event({
      id: "health_first",
      nodeId: "node_1",
      severity: "warning",
      status: "open",
      type: "watchdog.node_offline",
    }),
    event({
      details: { broadbandNoiseScore: 0.82 },
      id: "health_second",
      recordingId: "rec_1",
      severity: "critical",
      status: "acknowledged",
      type: "watchdog.quality_anomaly",
    }),
  ]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async () => true,
    healthEventStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: allowPermission,
  });

  const response = await requestJson(app, "/api/v1/health-events/export", "POST", {
    eventIds: ["health_second", "health_first", "health_second"],
  });
  const csv = await response.text();
  const [auditEvent] = await auditStore.list({
    action: "health.events.export_selected.succeeded",
  });
  const secondIndex = csv.indexOf("health_second");
  const firstIndex = csv.indexOf("health_first");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(csv, /"health_second","watchdog\.quality_anomaly","critical","acknowledged"/);
  assert.match(csv, /"health_first","watchdog\.node_offline","warning","open"/);
  assert.ok(secondIndex > -1 && firstIndex > secondIndex);
  assert.equal(auditEvent?.permission, "health:read");
  assert.equal(auditEvent?.details.exportedCount, 2);
  assert.equal(auditEvent?.details.requestedCount, 3);
  assert.equal(auditEvent?.correlationIds?.healthEventId1, "health_second");
  assert.equal(auditEvent?.correlationIds?.healthEventId2, "health_first");
});

test("selected health event export rejects hidden events before exporting", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["health:read"]);
  const healthEventStore = createHealthEventStore("", [
    event({ id: "health_visible", nodeId: "node_1" }),
    event({ id: "health_hidden", nodeId: "node_hidden" }),
  ]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async (_user, target) => target.id !== "node_hidden",
    healthEventStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: allowPermission,
  });

  const response = await requestJson(app, "/api/v1/health-events/export", "POST", {
    eventIds: ["health_visible", "health_hidden"],
  });
  const [auditEvent] = await auditStore.list({ action: "health.events.export_selected.failed" });

  assert.equal(response.status, 404);
  assert.equal(auditEvent?.outcome, "denied");
  assert.equal(auditEvent?.permission, "health:read");
  assert.equal(auditEvent?.reason, "health_event_not_visible");
  assert.equal(auditEvent?.details.hiddenId, "health_hidden");
});

test("health bulk lifecycle updates visible events and audits each event", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["health:acknowledge", "health:read"]);
  const healthEventStore = createHealthEventStore("", [
    event({ id: "health_bulk_open", nodeId: "node_1", status: "open" }),
    event({ id: "health_bulk_ack", nodeId: "node_1", status: "acknowledged" }),
  ]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async () => true,
    healthEventStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: allowPermission,
  });

  const response = await requestJson(app, "/api/v1/health-events/bulk-lifecycle", "POST", {
    action: "resolve",
    eventIds: ["health_bulk_open", "health_bulk_ack"],
    note: "incident cleared",
  });
  const body = (await response.json()) as { data: HealthEvent[]; meta: { updatedCount: number } };
  const auditEvents = await auditStore.list({ action: "health.events.resolve.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.meta.updatedCount, 2);
  assert.deepEqual(
    body.data.map((healthEvent) => healthEvent.status),
    ["resolved", "resolved"],
  );
  assert.deepEqual(
    body.data.map((healthEvent) => healthEvent.details.resolveNote),
    ["incident cleared", "incident cleared"],
  );
  assert.equal(auditEvents.length, 2);
  assert.ok(auditEvents.every((auditEvent) => auditEvent.permission === "health:acknowledge"));
  assert.deepEqual(auditEvents.map((auditEvent) => auditEvent.target.id).sort(), [
    "health_bulk_ack",
    "health_bulk_open",
  ]);
});

test("health lifecycle routes only operate on scoped visible events", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["health:acknowledge", "health:read"]);
  const visible = event({ id: "health_visible_lifecycle", nodeId: "node_1" });
  const hidden = event({
    details: { note: "do not touch" },
    id: "health_hidden_lifecycle",
    nodeId: "node_hidden",
    status: "open",
  });
  const healthEventStore = createHealthEventStore("", [visible, hidden]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async (_user, target) => target.id !== "node_hidden",
    healthEventStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: allowPermission,
  });

  const acknowledge = await requestJson(
    app,
    `/api/v1/health-events/${hidden.id}/acknowledge`,
    "POST",
    { note: "hidden ack" },
  );
  const suppress = await requestJson(app, `/api/v1/health-events/${hidden.id}/suppress`, "POST", {
    note: "hidden suppress",
    suppressedUntil: "2026-06-20T13:00:00.000Z",
  });
  const resolve = await requestJson(app, `/api/v1/health-events/${hidden.id}/resolve`, "POST", {
    note: "hidden resolve",
  });
  const reopen = await requestJson(app, `/api/v1/health-events/${hidden.id}/reopen`, "POST", {
    note: "hidden reopen",
  });
  const bulk = await requestJson(app, "/api/v1/health-events/bulk-lifecycle", "POST", {
    action: "resolve",
    eventIds: [visible.id, hidden.id],
    note: "hidden bulk",
  });
  const storedVisible = await healthEventStore.find(visible.id);
  const storedHidden = await healthEventStore.find(hidden.id);
  const failedEvents = await auditStore.list({ outcome: "failed" });

  assert.deepEqual(
    [acknowledge.status, suppress.status, resolve.status, reopen.status, bulk.status],
    [404, 404, 404, 404, 404],
  );
  assert.equal(storedVisible?.status, "open");
  assert.equal(storedHidden?.status, "open");
  assert.deepEqual(storedHidden?.details, { note: "do not touch" });
  assert.deepEqual(
    failedEvents.map((auditEvent) => `${auditEvent.action}:${auditEvent.reason}`).sort(),
    [
      "health.events.acknowledge.failed:health_event_not_found",
      "health.events.bulk_lifecycle.failed:health_event_not_found",
      "health.events.reopen.failed:health_event_not_found",
      "health.events.resolve.failed:health_event_not_found",
      "health.events.suppress.failed:health_event_not_found",
    ],
  );
});

function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "POST",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function allowPermissionWithCalls(permissionCalls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    const call: PermissionCall = {
      action,
      permission,
    };

    if (target) {
      call.target = await target(c);
    }

    permissionCalls.push(call);

    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const actor = input.actor ?? {
      id: input.auth?.user?.id ?? "anonymous",
      name: input.auth?.user?.name ?? "Anonymous",
      roles: input.auth?.user?.roles ?? [],
      type: "user" as const,
    };
    const event: AuditEvent = {
      action: input.action,
      actor,
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
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);
      const [deleted] = index >= 0 ? recordings.splice(index, 1) : [];

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      recordings.unshift(recording);
    },
  };
}

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "health-denied@example.com",
    groups: [],
    id: "user_health_denied",
    name: "Health Denied",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function event(input: Partial<HealthEvent> = {}): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_test",
    openedAt: "2026-06-20T12:00:00.000Z",
    resolvedAt: null,
    severity: "warning",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.node_offline",
    ...input,
  };
}
