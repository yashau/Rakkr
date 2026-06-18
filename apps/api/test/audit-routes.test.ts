import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, Permission } from "@rakkr/shared";
import type { AppBindings, RequirePermission } from "../src/http-types.js";

const { registerAuditRoutes } = await import("../src/audit-routes.js");
const { createAuditStore } = await import("../src/audit-store.js");

test("audit routes list events with filters", async () => {
  const auditStore = createAuditStore("");
  await auditStore.append(auditEvent("recordings.download.succeeded", "succeeded"));
  await auditStore.append(
    auditEvent("recordings.delete.denied", "denied", {
      actorName: "Blocked User",
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

function auditApp(auditStore: ReturnType<typeof createAuditStore>, calls: string[]) {
  const app = new Hono<AppBindings>();

  registerAuditRoutes({
    app,
    auditStore,
    requirePermission: requirePermission(calls),
  });

  return app;
}

function requirePermission(calls: string[]): RequirePermission {
  return (permission: Permission, action: string) => {
    return async (_c, next) => {
      calls.push(`${permission}:${action}`);
      await next();
    };
  };
}

function auditEvent(
  action: string,
  outcome: AuditEvent["outcome"],
  options: {
    actorName?: string;
    details?: Record<string, unknown>;
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
    permission: "audit:read",
    target: {
      id: "room_101",
      name: options.targetName ?? "Room 101",
      type: "room",
    },
  };
}
