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
    "auth.access_policies.update",
    "auth.groups.read",
    "auth.users.access.update",
    "auth.users.create",
    "auth.users.delete",
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
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), expectedActions);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.details.roles?.includes("viewer")));
});

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
