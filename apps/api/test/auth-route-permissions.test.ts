import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "@rakkr/shared";

process.env.DATABASE_URL = "";
process.env.RAKKR_API_NO_LISTEN = "1";
process.env.RAKKR_LOCAL_ACCESS_POLICIES = "";
process.env.RAKKR_LOCAL_ADMIN_ROLE = "viewer";

const { app } = await import("../src/index.js");

test("auth management routes deny users without auth manage", async () => {
  const deniedToken = await loginToken();
  const targetUserId = "00000000-0000-4000-8000-000000000001";
  const requests = [
    { path: "/api/v1/auth/actions" },
    { path: "/api/v1/auth/groups" },
    { path: "/api/v1/auth/users" },
    {
      body: {
        email: "denied-create@example.com",
        name: "Denied Create",
        password: "denied-password",
        resourceGrants: [],
        roles: ["viewer"],
      },
      method: "POST",
      path: "/api/v1/auth/users",
    },
    { path: "/api/v1/auth/access-policies" },
    {
      body: { policies: [] },
      method: "PATCH",
      path: "/api/v1/auth/access-policies",
    },
    { path: "/api/v1/auth/access-policies/actions" },
    { path: `/api/v1/auth/users/${targetUserId}` },
    { path: `/api/v1/auth/users/${targetUserId}/actions` },
    {
      body: { groupIds: [], resourceGrants: [], roles: ["viewer"] },
      method: "PATCH",
      path: `/api/v1/auth/users/${targetUserId}/access`,
    },
    {
      body: { password: "new-denied-password" },
      method: "PATCH",
      path: `/api/v1/auth/users/${targetUserId}/password`,
    },
    {
      body: { disabled: true },
      method: "PATCH",
      path: `/api/v1/auth/users/${targetUserId}/status`,
    },
    {
      method: "DELETE",
      path: `/api/v1/auth/users/${targetUserId}`,
    },
  ];

  const responses = await Promise.all(
    requests.map((request) =>
      app.request(request.path, {
        body: request.body ? JSON.stringify(request.body) : undefined,
        headers: {
          authorization: `Bearer ${deniedToken}`,
          "content-type": "application/json",
        },
        method: request.method ?? "GET",
      }),
    ),
  );

  process.env.RAKKR_LOCAL_ADMIN_ROLE = "owner";

  const auditToken = await loginToken();
  const eventsResponse = await app.request(
    "/api/v1/audit-events?outcome=denied&permission=auth%3Amanage",
    {
      headers: { authorization: `Bearer ${auditToken}` },
    },
  );
  const body = (await eventsResponse.json()) as { data: AuditEvent[] };
  const expectedActions = [
    "auth.access_policies.read",
    "auth.access_policies.actions.read",
    "auth.access_policies.update",
    "auth.actions.read",
    "auth.groups.read",
    "auth.users.access.update",
    "auth.users.actions.read",
    "auth.users.create",
    "auth.users.delete",
    "auth.users.detail.read",
    "auth.users.password.reset",
    "auth.users.read",
    "auth.users.status.update",
  ];
  const deniedEvents = body.data.filter((event) => expectedActions.includes(event.action));

  assert.deepEqual(
    responses.map((response) => response.status),
    Array.from({ length: requests.length }, () => 403),
  );
  assert.equal(eventsResponse.status, 200);
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [...expectedActions].sort());
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.details.roles?.includes("viewer")));
});

test("auth management action summaries expose admin user lifecycle readiness", async () => {
  process.env.RAKKR_LOCAL_ADMIN_ROLE = "owner";

  const token = await loginToken();
  const authHeaders = { authorization: `Bearer ${token}` };
  const meResponse = await app.request("/api/v1/auth/me", { headers: authHeaders });
  const me = (await meResponse.json()) as { data: { id: string } };

  const [rootResponse, policiesResponse, detailResponse, actionsResponse, missingResponse] =
    await Promise.all([
      app.request("/api/v1/auth/actions", { headers: authHeaders }),
      app.request("/api/v1/auth/access-policies/actions", { headers: authHeaders }),
      app.request(`/api/v1/auth/users/${me.data.id}`, { headers: authHeaders }),
      app.request(`/api/v1/auth/users/${me.data.id}/actions`, { headers: authHeaders }),
      app.request("/api/v1/auth/users/user_missing/actions", { headers: authHeaders }),
    ]);

  const root = (await rootResponse.json()) as AuthActionsResponse;
  const policies = (await policiesResponse.json()) as AuthActionsResponse;
  const detail = (await detailResponse.json()) as UserActionsResponse;
  const actions = (await actionsResponse.json()) as UserActionsResponse;

  assert.equal(meResponse.status, 200);
  assert.equal(rootResponse.status, 200);
  assert.equal(root.data.actions.createUser.enabled, true);
  assert.equal(root.data.actions.listUsers.href, "/api/v1/auth/users");
  assert.equal(policiesResponse.status, 200);
  assert.equal(policies.data.actions.update.href, "/api/v1/auth/access-policies");
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.data.user.id, me.data.id);
  assert.equal(detail.data.actions.resetPassword.enabled, true);
  assert.equal(detail.data.actions.updateAccess.enabled, true);
  assert.equal(detail.data.actions.disable.enabled, false);
  assert.equal(detail.data.actions.disable.reason, "self_disable_denied");
  assert.equal(detail.data.actions.delete.enabled, false);
  assert.equal(detail.data.actions.delete.reason, "self_delete_denied");
  assert.equal(detail.data.actions.enable.reason, "user_already_enabled");
  assert.equal(actionsResponse.status, 200);
  assert.deepEqual(actions.data.actions, detail.data.actions);
  assert.equal(actions.data.links.status, `/api/v1/auth/users/${me.data.id}/status`);
  assert.equal(missingResponse.status, 404);
});

interface AuthActionsResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; reason?: string }>;
  };
}

interface UserActionsResponse extends AuthActionsResponse {
  data: AuthActionsResponse["data"] & {
    links: Record<string, string>;
    user: {
      id: string;
    };
  };
}

async function loginToken() {
  const response = await app.request("/api/v1/auth/login", {
    body: JSON.stringify({
      email: "admin@rakkr.local",
      password: "rakkr-local-dev-password",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { data: { token: string } };

  assert.equal(response.status, 200);

  return body.data.token;
}
