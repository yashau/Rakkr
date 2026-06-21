import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission } from "@rakkr/shared";
import type { AppBindings, RequirePermission } from "../src/http-types.js";

const { registerAuditRoutes } = await import("../src/audit-routes.js");
const { createAuditStore } = await import("../src/audit-store.js");

test("audit routes list events with filters", async () => {
  const auditStore = createAuditStore("");
  await auditStore.append(auditEvent("recordings.download.succeeded", "succeeded"));
  await auditStore.append(
    auditEvent("recordings.delete.denied", "denied", {
      actorName: "Blocked User",
      permission: "recording:delete",
      reason: "access_policy_denied",
      targetName: "Room 202",
    }),
  );
  const permissions: string[] = [];
  const app = auditApp(auditStore, permissions);

  const response = await app.request("/api/v1/audit-events?actor=alice&outcome=succeeded");
  const body = (await response.json()) as { data: AuditEvent[] };

  assert.equal(response.status, 200);
  assert.ok(permissions.includes("audit:read:audit.events.read"));
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]?.action, "recordings.download.succeeded");

  const deniedResponse = await app.request(
    "/api/v1/audit-events?permission=recording%3Adelete&reason=access_policy",
  );
  const deniedBody = (await deniedResponse.json()) as { data: AuditEvent[] };
  const idResponse = await app.request("/api/v1/audit-events?id=audit_recordings.delete.denied");
  const idBody = (await idResponse.json()) as { data: AuditEvent[] };
  const invalidResponse = await app.request("/api/v1/audit-events?permission=unknown");

  assert.equal(deniedResponse.status, 200);
  assert.deepEqual(
    deniedBody.data.map((event) => event.action),
    ["recordings.delete.denied"],
  );
  assert.equal(idResponse.status, 200);
  assert.deepEqual(
    idBody.data.map((event) => event.id),
    ["audit_recordings.delete.denied"],
  );
  assert.equal(invalidResponse.status, 400);
});

test("audit detail and action summary expose single-event links and export", async () => {
  const auditStore = createAuditStore("");
  const event = auditEvent("recordings.playback.succeeded", "succeeded", {
    details: { sessionId: "listen_123" },
    targetName: "Room 301",
  });

  await auditStore.append(event);

  const permissions: string[] = [];
  const app = auditApp(auditStore, permissions);
  const [detailResponse, actionsResponse, exportResponse, missingResponse] = await Promise.all([
    app.request(`/api/v1/audit-events/${event.id}`),
    app.request(`/api/v1/audit-events/${event.id}/actions`),
    app.request(`/api/v1/audit-events/export?id=${event.id}`),
    app.request("/api/v1/audit-events/audit_missing_event"),
  ]);
  const detail = (await detailResponse.json()) as AuditDetailResponse;
  const actions = (await actionsResponse.json()) as AuditDetailResponse;
  const csv = await exportResponse.text();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.data.event.id, event.id);
  assert.equal(detail.data.actions.detail.href, `/api/v1/audit-events/${event.id}`);
  assert.equal(detail.data.actions.export.href, `/api/v1/audit-events/export?id=${event.id}`);
  assert.equal(actionsResponse.status, 200);
  assert.deepEqual(actions.data.actions, detail.data.actions);
  assert.equal(actions.data.links.actions, `/api/v1/audit-events/${event.id}/actions`);
  assert.equal(exportResponse.status, 200);
  assert.match(csv, /recordings\.playback\.succeeded/);
  assert.doesNotMatch(csv, /recordings\.delete\.denied/);
  assert.equal(missingResponse.status, 404);
  assert.ok(permissions.includes("audit:read:audit.events.detail.read"));
  assert.ok(permissions.includes("audit:read:audit.events.actions.read"));
  assert.ok(permissions.includes("audit:read:audit.events.export"));
});

test("audit routes export filtered events as csv", async () => {
  const auditStore = createAuditStore("");
  await auditStore.append(
    auditEvent("recordings.tag.succeeded", "succeeded", {
      details: { count: 2, level: "critical" },
      targetName: "Room 101",
    }),
  );
  await auditStore.append(
    auditEvent("recordings.tag.denied", "denied", {
      targetName: "Room 202",
    }),
  );
  const permissions: string[] = [];
  const app = auditApp(auditStore, permissions);

  const response = await app.request("/api/v1/audit-events/export?target=Room%20101");
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.ok(permissions.includes("audit:read:audit.events.export"));
  assert.match(response.headers.get("content-disposition") ?? "", /rakkr-audit-events-/);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(body, /^"createdAt","actorType","actorId"/);
  assert.match(body, /recordings\.tag\.succeeded/);
  assert.match(body, /Room 101/);
  assert.doesNotMatch(body, /Room 202/);
  assert.match(body, /"{""count"":2,""level"":""critical""}"/);
});

test("audit routes deny users without audit read", async () => {
  const auditStore = createAuditStore("");
  const currentUser = user([]);
  const app = new Hono<AppBindings>();

  registerAuditRoutes({
    app,
    auditStore,
    requirePermission: denyMissingPermission(auditStore, currentUser),
  });

  const responses = await Promise.all([
    app.request("/api/v1/audit-events"),
    app.request("/api/v1/audit-events/export"),
    app.request("/api/v1/audit-events/audit_denied_event"),
    app.request("/api/v1/audit-events/audit_denied_event/actions"),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "audit:read" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "audit.events.actions.read",
    "audit.events.detail.read",
    "audit.events.export",
    "audit.events.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === currentUser.id));
  assert.ok(deniedEvents.every((event) => event.target.type === "controller"));
});

function auditApp(auditStore: ReturnType<typeof createAuditStore>, calls: string[]) {
  const app = new Hono<AppBindings>();

  registerAuditRoutes({
    app,
    auditStore,
    requirePermission: requirePermission(calls),
  });

  return app;
}

interface AuditDetailResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; permission: Permission }>;
    event: AuditEvent;
    links: Record<string, string>;
  };
}

function requirePermission(calls: string[]): RequirePermission {
  return (permission: Permission, action: string) => {
    return async (_c, next) => {
      calls.push(`${permission}:${action}`);
      await next();
    };
  };
}

function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await auditStore.append({
      action,
      actor: {
        id: currentUser.id,
        name: currentUser.name,
        roles: currentUser.roles,
        type: "user",
      },
      actorContext: {},
      createdAt: new Date().toISOString(),
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      id: `audit_${randomUUID()}`,
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "audit-denied@example.com",
    groups: [],
    id: "user_audit_denied",
    name: "Audit Denied",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function auditEvent(
  action: string,
  outcome: AuditEvent["outcome"],
  options: {
    actorName?: string;
    details?: Record<string, unknown>;
    permission?: Permission;
    reason?: string;
    targetName?: string;
  } = {},
): AuditEvent {
  return {
    action,
    actor: {
      id: `user_${options.actorName ?? "alice"}`,
      name: options.actorName ?? "Alice Example",
      roles: ["auditor"],
      type: "user",
    },
    actorContext: {},
    correlationIds: { requestId: `req_${action}` },
    createdAt: "2026-06-18T12:00:00.000Z",
    details: options.details ?? {},
    id: `audit_${action}`,
    outcome,
    permission: options.permission ?? "audit:read",
    reason: options.reason,
    target: {
      id: "room_101",
      name: options.targetName ?? "Room 101",
      type: "room",
    },
  };
}
