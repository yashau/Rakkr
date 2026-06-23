import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  HealthEvent,
  Permission,
  RecorderNode,
  RecordingSummary,
} from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { LocalAuthService } = await import("../src/auth-service.js");
const { registerAuthOidcRoutes } = await import("../src/auth-oidc-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { createMeterFrameStore } = await import("../src/meter-store.js");
const { registerMetricsRoutes } = await import("../src/metrics-routes.js");
const { createNodeStore } = await import("../src/node-store.js");
const { createRecordingStore } = await import("../src/recording-store.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { registerStatusRoutes } = await import("../src/status-routes.js");

test("ops routes deny users without required permissions", async () => {
  const auditStore = createAuditStore("");
  const deniedUser = user([]);
  const app = new Hono<AppBindings>();
  const requirePermission = denyMissingPermission(auditStore, deniedUser);

  registerMetricsRoutes({
    app,
    auditStore,
    currentUser: () => deniedUser,
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
    listenMonitorStore: createListenMonitorStore(),
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: createRecordingStore([]),
    requirePermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });
  registerStatusRoutes({
    app,
    currentUser: () => deniedUser,
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission,
    scopedNodes: async () => [],
    scopedRecordings: async () => [],
    settingsStore: createSettingsStore(),
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });
  registerAuthOidcRoutes({
    app,
    authService: new LocalAuthService(""),
    configProvider: () => ({
      clientId: "client-id",
      configured: true,
      enabled: true,
      issuer: "https://login.microsoftonline.com/tenant-id/v2.0",
      loginAvailable: true,
      redirectUri: "https://rakkr.example.com/api/v1/auth/oidc/callback",
      scopes: ["openid", "profile", "email"],
    }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission,
    sessionContext: () => ({}),
    webOrigin: "http://localhost:5173",
  });

  const responses = await Promise.all([
    app.request("/metrics"),
    app.request("/api/v1/status"),
    app.request("/api/v1/auth/oidc/discovery/actions"),
    app.request("/api/v1/auth/oidc/discovery"),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403],
  );
  assert.deepEqual(
    Object.fromEntries(deniedEvents.map((event) => [event.action, event.permission]).sort()),
    {
      "auth.oidc.discovery.actions.read": "auth:manage",
      "auth.oidc.discovery.read": "auth:manage",
      "metrics.read": "metrics:read",
      "status.read": "node:read",
    },
  );
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === deniedUser.id));
});

test("status route only includes settings summaries with settings read", async () => {
  const statusApp = (currentUser: CurrentUser) => {
    const auditStore = createAuditStore("");
    const app = new Hono<AppBindings>();

    registerStatusRoutes({
      app,
      currentUser: () => currentUser,
      hasResourceScope: async () => true,
      healthEventStore: createHealthEventStore("", []),
      recordAuditEvent: recordAuditEvent(auditStore),
      requirePermission: allowPermission,
      scopedNodes: async () => [],
      scopedRecordings: async () => [],
      settingsStore: createSettingsStore(),
      startedAt: new Date("2026-06-18T12:00:00.000Z"),
    });

    return { app, auditStore };
  };

  const nodeOnlyStatus = statusApp(user(["node:read"]));
  const nodeOnlyResponse = await nodeOnlyStatus.app.request("/api/v1/status");
  const nodeOnlyBody = (await nodeOnlyResponse.json()) as Record<string, unknown>;
  const settingsStatus = statusApp(user(["node:read", "settings:read"]));
  const settingsResponse = await settingsStatus.app.request("/api/v1/status");
  const settingsBody = (await settingsResponse.json()) as Record<string, unknown>;
  const [nodeOnlyEvent] = await nodeOnlyStatus.auditStore.list({ action: "status.read.succeeded" });
  const [settingsEvent] = await settingsStatus.auditStore.list({ action: "status.read.succeeded" });

  assert.equal(nodeOnlyResponse.status, 200);
  assert.equal(settingsResponse.status, 200);
  assert.equal("recordingProfile" in nodeOnlyBody, false);
  assert.equal("watchdogPolicy" in nodeOnlyBody, false);
  assert.equal(typeof settingsBody.recordingProfile, "object");
  assert.equal(typeof settingsBody.watchdogPolicy, "object");
  assert.equal(nodeOnlyEvent?.details.canReadSettings, false);
  assert.equal(nodeOnlyEvent?.details.recordingProfileAvailable, false);
  assert.equal(settingsEvent?.details.canReadSettings, true);
  assert.equal(settingsEvent?.details.recordingProfileAvailable, true);
});

test("status route includes scoped operational aggregates", async () => {
  const auditStore = createAuditStore("");
  const app = new Hono<AppBindings>();

  registerStatusRoutes({
    app,
    currentUser: () => user(["node:read"]),
    hasResourceScope: async (_user, target) => target.id !== "health_hidden",
    healthEventStore: createHealthEventStore("", [
      healthEvent({ id: "health_critical", nodeId: "node_online", severity: "critical" }),
      healthEvent({
        id: "health_warning_ack",
        nodeId: "node_recording",
        severity: "warning",
        status: "acknowledged",
      }),
      healthEvent({
        id: "health_warning_resolved",
        resolvedAt: "2026-06-20T12:30:00.000Z",
        severity: "warning",
        status: "resolved",
      }),
      healthEvent({ id: "health_suppressed", severity: "info", status: "suppressed" }),
      healthEvent({ id: "health_hidden", nodeId: "health_hidden", severity: "critical" }),
    ]),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission,
    scopedNodes: async () => [
      node({ id: "node_online", status: "online" }),
      node({ id: "node_offline", status: "offline" }),
      node({ id: "node_degraded", status: "degraded" }),
      node({ id: "node_recording", status: "recording" }),
      node({ id: "node_alerting", status: "alerting" }),
    ],
    scopedRecordings: async () => [
      recording({ cached: true, id: "rec_recording", status: "recording" }),
      recording({ cached: true, id: "rec_cached", status: "cached" }),
      recording({ id: "rec_completed", status: "completed" }),
      recording({ id: "rec_failed", status: "failed" }),
      recording({ id: "rec_queued", status: "queued" }),
      recording({ id: "rec_uploaded", status: "uploaded" }),
    ],
    settingsStore: createSettingsStore(),
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/api/v1/status");
  const body = (await response.json()) as Record<string, unknown>;
  const [event] = await auditStore.list({ action: "status.read.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.nodeCount, 5);
  assert.equal(body.onlineNodes, 1);
  assert.equal(body.offlineNodes, 1);
  assert.equal(body.degradedNodes, 1);
  assert.equal(body.recordingNodes, 1);
  assert.equal(body.alertingNodes, 1);
  assert.equal(body.totalRecordings, 6);
  assert.equal(body.activeRecordings, 1);
  assert.equal(body.cachedRecordings, 2);
  assert.equal(body.completedRecordings, 1);
  assert.equal(body.failedRecordings, 1);
  assert.equal(body.queuedRecordings, 1);
  assert.equal(body.uploadedRecordings, 1);
  assert.equal(body.unresolvedAlerts, 3);
  assert.equal(body.criticalAlerts, 1);
  assert.equal(body.warningAlerts, 1);
  assert.equal(body.openAlerts, 1);
  assert.equal(body.acknowledgedAlerts, 1);
  assert.equal(body.suppressedAlerts, 1);
  assert.equal(event?.details.nodeCount, 5);
  assert.equal(event?.details.totalRecordings, 6);
  assert.equal(event?.details.criticalAlerts, 1);
  assert.equal(event?.details.unresolvedAlerts, 3);
});

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

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "ops-denied@example.com",
    groups: [],
    id: "user_ops_denied_test",
    name: "Ops Denied Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function healthEvent(input: Partial<HealthEvent> = {}): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_status_test",
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

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    alias: "Status Node",
    id: "node_status_test",
    interfaces: [],
    ipAddresses: ["10.0.0.50"],
    status: "online",
    tags: [],
    ...input,
  };
}

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: "rec_status_test",
    name: "Status Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: [],
    ...input,
  };
}
