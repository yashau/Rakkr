import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";

import type { AuditEvent, CurrentUser, Permission } from "@rakkr/shared";

import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { SwitcherStore } from "../src/switcher-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerSwitcherRoutes } = await import("../src/switcher-routes.js");

const stubStore: SwitcherStore = {
  async create() {
    throw new Error("unexpected create");
  },
  async delete() {
    return false;
  },
  async find() {
    return undefined;
  },
  async list() {
    return [];
  },
  async resolveConfig() {
    return undefined;
  },
  async update() {
    return undefined;
  },
};

test("switcher routes deny users without the required permission", async () => {
  const auditStore = createAuditStore("");
  const deniedUser = user([]);
  const app = new Hono<AppBindings>();

  registerSwitcherRoutes({
    app,
    currentAuth: () => ({ user: deniedUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, deniedUser),
    switcherStore: stubStore,
  });

  const responses = await Promise.all([
    app.request("/api/v1/settings/switchers"),
    app.request("/api/v1/settings/switchers/switcher_x"),
    app.request("/api/v1/settings/switchers", { method: "POST" }),
    app.request("/api/v1/settings/switchers/switcher_x", { method: "PATCH" }),
    app.request("/api/v1/settings/switchers/switcher_x", { method: "DELETE" }),
    app.request("/api/v1/settings/switchers/switcher_x/test", { method: "POST" }),
    app.request("/api/v1/settings/switchers/switcher_x/config-snapshot"),
    app.request("/api/v1/settings/switchers/switcher_x/restore", { method: "POST" }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.ok(
    responses.every((response) => response.status === 403),
    "every switcher route must deny without permission",
  );
  assert.deepEqual(
    Object.fromEntries(deniedEvents.map((event) => [event.action, event.permission])),
    {
      "settings.switchers.create": "switcher:manage",
      "settings.switchers.delete": "switcher:manage",
      "settings.switchers.read": "switcher:read",
      "settings.switchers.restore": "switcher:manage",
      "settings.switchers.snapshot": "switcher:manage",
      "settings.switchers.test": "switcher:manage",
      "settings.switchers.update": "switcher:manage",
    },
  );
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
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
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: input.auth?.user?.id ?? "anonymous",
        name: input.auth?.user?.name ?? "Anonymous",
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

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "switcher-denied@example.com",
    groups: [],
    id: "user_switcher_denied_test",
    name: "Switcher Denied Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
