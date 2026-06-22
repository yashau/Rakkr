import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission } from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";

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

test("audit facets summarize filtered investigation dimensions", async () => {
  const auditStore = createAuditStore("");

  await auditStore.append(
    auditEvent("recordings.delete.denied", "denied", {
      permission: "recording:delete",
      reason: "missing_permission",
      targetName: "Room 101",
    }),
  );
  await auditStore.append(
    auditEvent("recordings.download.denied", "denied", {
      permission: "recording:download",
      reason: "missing_permission",
      targetName: "Room 202",
    }),
  );
  await auditStore.append(
    auditEvent("recordings.download.succeeded", "succeeded", {
      permission: "recording:download",
      targetName: "Room 202",
    }),
  );

  const permissions: string[] = [];
  const app = auditApp(auditStore, permissions);
  const response = await app.request("/api/v1/audit-events/facets?outcome=denied");
  const body = (await response.json()) as {
    data: {
      actions: Array<{ count: number; value: string }>;
      actorTypes: Array<{ count: number; value: string }>;
      outcomes: Array<{ count: number; value: string }>;
      permissions: Array<{ count: number; value: string }>;
      reasons: Array<{ count: number; value: string }>;
      targetTypes: Array<{ count: number; value: string }>;
      total: number;
    };
  };
  const invalidResponse = await app.request("/api/v1/audit-events/facets?permission=unknown");

  assert.equal(response.status, 200);
  assert.ok(permissions.includes("audit:read:audit.events.facets.read"));
  assert.equal(body.data.total, 2);
  assert.deepEqual(body.data.outcomes, [{ count: 2, value: "denied" }]);
  assert.deepEqual(body.data.permissions, [
    { count: 1, value: "recording:delete" },
    { count: 1, value: "recording:download" },
  ]);
  assert.deepEqual(body.data.reasons, [{ count: 2, value: "missing_permission" }]);
  assert.deepEqual(body.data.actorTypes, [{ count: 2, value: "user" }]);
  assert.deepEqual(body.data.targetTypes, [{ count: 2, value: "room" }]);
  assert.equal(invalidResponse.status, 400);
});

test("audit routes hide resource-scoped events outside visibility", async () => {
  const auditStore = createAuditStore("");
  const visible = auditEvent("recordings.visible.succeeded", "succeeded", {
    targetId: "room_visible",
    targetName: "Visible Room",
  });
  const hidden = auditEvent("recordings.hidden.succeeded", "succeeded", {
    targetId: "room_hidden",
    targetName: "Hidden Room",
  });

  await auditStore.append(visible);
  await auditStore.append(hidden);

  const app = auditApp(auditStore, [], {
    hasResourceScope: async (_user, target) => target.id !== hidden.target.id,
  });
  const [
    listResponse,
    exportResponse,
    facetsResponse,
    hiddenDetailResponse,
    hiddenActionsResponse,
  ] = await Promise.all([
    app.request("/api/v1/audit-events"),
    app.request("/api/v1/audit-events/export"),
    app.request("/api/v1/audit-events/facets"),
    app.request(`/api/v1/audit-events/${hidden.id}`),
    app.request(`/api/v1/audit-events/${hidden.id}/actions`),
  ]);
  const listBody = (await listResponse.json()) as { data: AuditEvent[] };
  const exportCsv = await exportResponse.text();
  const facetsBody = (await facetsResponse.json()) as {
    data: { targetTypes: Array<{ count: number; value: string }>; total: number };
  };
  const selectedResponse = await app.request("/api/v1/audit-events/export", {
    body: JSON.stringify({ eventIds: [visible.id, hidden.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(listResponse.status, 200);
  assert.deepEqual(
    listBody.data.map((event) => event.id),
    [visible.id],
  );
  assert.equal(exportResponse.status, 200);
  assert.match(exportCsv, /recordings\.visible\.succeeded/);
  assert.doesNotMatch(exportCsv, /recordings\.hidden\.succeeded/);
  assert.equal(facetsResponse.status, 200);
  assert.equal(facetsBody.data.total, 1);
  assert.deepEqual(facetsBody.data.targetTypes, [{ count: 1, value: "room" }]);
  assert.equal(hiddenDetailResponse.status, 404);
  assert.equal(hiddenActionsResponse.status, 404);
  assert.equal(selectedResponse.status, 404);
  assert.equal((await selectedResponse.json()).eventId, hidden.id);
});

test("audit selected export preserves requested order and audits outcomes", async () => {
  const auditStore = createAuditStore("");
  const first = auditEvent("recordings.tag.succeeded", "succeeded", {
    targetName: "Room 101",
  });
  const second = auditEvent("recordings.delete.denied", "denied", {
    reason: "access_policy_denied",
    targetName: "Room 202",
  });

  await auditStore.append(first);
  await auditStore.append(second);

  const permissions: string[] = [];
  const app = auditApp(auditStore, permissions);
  const response = await app.request("/api/v1/audit-events/export", {
    body: JSON.stringify({ eventIds: [second.id, first.id, second.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const csv = await response.text();
  const missingResponse = await app.request("/api/v1/audit-events/export", {
    body: JSON.stringify({ eventIds: [first.id, "audit_missing"] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const successEvents = await auditStore.list({ action: "audit.events.export_selected.succeeded" });
  const failedEvents = await auditStore.list({ action: "audit.events.export_selected.failed" });

  assert.equal(response.status, 200);
  assert.ok(permissions.includes("audit:read:audit.events.export_selected"));
  assert.match(response.headers.get("content-disposition") ?? "", /rakkr-audit-events-/);
  assert.equal(
    csv.split("\n").filter((row) => row.includes('"recordings.delete.denied"')).length,
    1,
  );
  assert.equal(
    csv.split("\n").filter((row) => row.includes('"recordings.tag.succeeded"')).length,
    1,
  );
  assert.ok(csv.indexOf("recordings.delete.denied") < csv.indexOf("recordings.tag.succeeded"));
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).eventId, "audit_missing");
  assert.equal(successEvents[0]?.details.exportedCount, 2);
  assert.equal(successEvents[0]?.details.requestedCount, 3);
  assert.equal(failedEvents[0]?.reason, "audit_event_not_found");
});

test("audit routes deny users without audit read", async () => {
  const auditStore = createAuditStore("");
  const currentUser = user([]);
  const app = new Hono<AppBindings>();

  registerAuditRoutes({
    app,
    auditStore,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async () => true,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, currentUser),
  });

  const responses = await Promise.all([
    app.request("/api/v1/audit-events"),
    app.request("/api/v1/audit-events/export"),
    app.request("/api/v1/audit-events/facets"),
    app.request("/api/v1/audit-events/export", {
      body: JSON.stringify({ eventIds: ["audit_denied_event"] }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
    app.request("/api/v1/audit-events/audit_denied_event"),
    app.request("/api/v1/audit-events/audit_denied_event/actions"),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "audit:read" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "audit.events.actions.read",
    "audit.events.detail.read",
    "audit.events.export",
    "audit.events.export_selected",
    "audit.events.facets.read",
    "audit.events.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === currentUser.id));
  assert.ok(deniedEvents.every((event) => event.target.type === "controller"));
});

function auditApp(
  auditStore: ReturnType<typeof createAuditStore>,
  calls: string[],
  options: {
    hasResourceScope?: (user: CurrentUser, target: AuditTarget) => Promise<boolean>;
  } = {},
) {
  const app = new Hono<AppBindings>();

  registerAuditRoutes({
    app,
    auditStore,
    currentAuth: () => ({ user: user(["audit:read"]) }),
    hasResourceScope: options.hasResourceScope ?? (async () => true),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: requirePermission(calls),
  });

  return app;
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: input.auth?.user?.id ?? "user_audit_test",
        name: input.auth?.user?.name ?? "Audit Test",
        roles: input.auth?.user?.roles ?? [],
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
    targetId?: string;
    targetName?: string;
    targetType?: AuditEvent["target"]["type"];
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
      id: options.targetId ?? "room_101",
      name: options.targetName ?? "Room 101",
      type: options.targetType ?? "room",
    },
  };
}
