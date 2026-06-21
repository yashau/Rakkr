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
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
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
    [403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => `${event.permission}:${event.action}`).sort(), [
    "health:acknowledge:health.events.acknowledge",
    "health:acknowledge:health.events.bulk_lifecycle",
    "health:acknowledge:health.events.create",
    "health:acknowledge:health.events.reopen",
    "health:acknowledge:health.events.resolve",
    "health:acknowledge:health.events.suppress",
    "health:read:health.events.export",
    "health:read:health.events.export_selected",
    "health:read:health.events.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === currentUser.id));
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
    "/api/v1/health-events/export?severity=critical&type=watchdog.scheduled_low_signal&openedFrom=2026-06-20T00:00:00.000Z&openedTo=2026-06-20T23:59:59.999Z&resolvedFrom=2026-06-20T00:00:00.000Z&resolvedTo=2026-06-20T23:59:59.999Z",
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
