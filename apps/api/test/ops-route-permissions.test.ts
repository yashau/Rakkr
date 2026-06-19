import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { LocalAuthService } = await import("../src/auth-service.js");
const { registerAuthOidcRoutes } = await import("../src/auth-oidc-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
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
    currentUser: () => deniedUser,
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([]),
    recordingStore: createRecordingStore([]),
    requirePermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });
  registerStatusRoutes({
    app,
    currentUser: () => deniedUser,
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
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
    app.request("/api/v1/auth/oidc/discovery"),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403],
  );
  assert.deepEqual(
    Object.fromEntries(deniedEvents.map((event) => [event.action, event.permission]).sort()),
    {
      "auth.oidc.discovery.read": "auth:manage",
      "metrics.read": "metrics:read",
      "status.read": "node:read",
    },
  );
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === deniedUser.id));
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
