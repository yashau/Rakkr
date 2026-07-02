import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

process.env.DATABASE_URL = "";
process.env.RAKKR_LOCAL_ACCESS_POLICIES = "";
process.env.RAKKR_LOCAL_ADMIN_GROUPS = "";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAuthManagementRoutes } = await import("../src/auth-management-routes.js");
const { LocalAuthService } = await import("../src/auth-service.js");

// registerAuthManagementRoutes also wires the group routes, which borrow these
// stores only for delete-cascade cleanup — never exercised by the tests here
// (group route behavior is covered in auth-group-routes.test.ts).
type ManagementDeps = Parameters<typeof registerAuthManagementRoutes>[0];
const groupCascadeStubs = {
  roomRosterStore: {
    removeGroupSubject: async () => {},
  } as unknown as ManagementDeps["roomRosterStore"],
  scheduleStore: {
    list: async () => [],
    update: async () => undefined,
  } as unknown as ManagementDeps["scheduleStore"],
};

test("auth management read and action-summary routes audit successes and missing users", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const authService = new LocalAuthService("");
  const localAdmin = await authService.localAdmin();
  const currentUser = manager(localAdmin);

  registerAuthManagementRoutes({
    app,
    authService,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    roomRosterStore: groupCascadeStubs.roomRosterStore,
    scheduleStore: groupCascadeStubs.scheduleStore,
  });

  const rootResponse = await app.request("/api/v1/auth/actions");
  const policiesResponse = await app.request("/api/v1/auth/access-policies/actions");
  const detailResponse = await app.request(`/api/v1/auth/users/${localAdmin.id}`);
  const actionsResponse = await app.request(`/api/v1/auth/users/${localAdmin.id}/actions`);
  const missingDetailResponse = await app.request("/api/v1/auth/users/user_missing_read");
  const missingActionsResponse = await app.request(
    "/api/v1/auth/users/user_missing_actions/actions",
  );
  const successAudits = await auditStore.list({
    outcome: "succeeded",
    permission: "auth:manage",
  });
  const failedAudits = await auditStore.list({
    outcome: "failed",
    permission: "auth:manage",
  });

  assert.equal(rootResponse.status, 200);
  assert.equal(policiesResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.equal(actionsResponse.status, 200);
  assert.equal(missingDetailResponse.status, 404);
  assert.equal(missingActionsResponse.status, 404);
  assert.deepEqual(successAudits.map((event) => event.action).sort(), [
    "auth.access_policies.actions.read.succeeded",
    "auth.actions.read.succeeded",
    "auth.users.actions.read.succeeded",
    "auth.users.detail.read.succeeded",
  ]);
  assert.equal(
    successAudits.find((event) => event.action === "auth.actions.read.succeeded")?.details
      .visibleActionCount,
    6,
  );
  assert.deepEqual(
    successAudits.find((event) => event.action === "auth.access_policies.actions.read.succeeded")
      ?.details,
    {
      policyCount: 0,
      visibleActionCount: 2,
    },
  );
  assert.equal(
    successAudits.find((event) => event.action === "auth.users.detail.read.succeeded")?.target.id,
    localAdmin.id,
  );
  assert.equal(
    successAudits.find((event) => event.action === "auth.users.actions.read.succeeded")?.target.id,
    localAdmin.id,
  );
  assert.deepEqual(failedAudits.map((event) => [event.action, event.reason]).sort(), [
    ["auth.users.actions.read.failed", "user_not_found"],
    ["auth.users.detail.read.failed", "user_not_found"],
  ]);
  assert.equal(
    failedAudits.find((event) => event.action === "auth.users.detail.read.failed")?.target.id,
    "user_missing_read",
  );
  assert.equal(
    failedAudits.find((event) => event.action === "auth.users.actions.read.failed")?.target.id,
    "user_missing_actions",
  );
});

test("auth users/groups list routes clamp pagination to the page policy", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const authService = new LocalAuthService("");
  const currentUser = manager(await authService.localAdmin());

  registerAuthManagementRoutes({
    app,
    authService,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    roomRosterStore: groupCascadeStubs.roomRosterStore,
    scheduleStore: groupCascadeStubs.scheduleStore,
  });

  for (const base of ["/api/v1/auth/users", "/api/v1/auth/groups"]) {
    const omitted = (await (await app.request(base)).json()) as { meta: { limit?: number } };
    const huge = (await (await app.request(`${base}?limit=99999`)).json()) as {
      meta: { limit?: number };
    };
    const zero = (await (await app.request(`${base}?limit=0`)).json()) as {
      meta: { limit?: number };
    };

    // Pre-fix: an omitted limit returned every row (meta.limit undefined), a huge
    // limit was honoured verbatim, and limit=0 produced a garbled empty page.
    assert.equal(omitted.meta.limit, 50, `${base} should default to the page policy`);
    assert.equal(huge.meta.limit, 200, `${base} should clamp to the page-policy max`);
    assert.equal(zero.meta.limit, 1, `${base} should floor limit at 1`);
  }
});

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: input.auth?.user?.id ?? "user_auth_management_test",
        name: input.auth?.user?.name ?? "Auth Management Test",
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

function manager(base: CurrentUser): CurrentUser {
  return {
    ...base,
    permissions: ["auth:manage"],
    roles: ["owner"],
  };
}
