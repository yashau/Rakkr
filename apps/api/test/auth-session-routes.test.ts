import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "@rakkr/shared";

process.env.DATABASE_URL = "";
process.env.RAKKR_API_NO_LISTEN = "1";
process.env.RAKKR_LOCAL_ACCESS_POLICIES = "";
process.env.RAKKR_LOCAL_ADMIN_ROLE = "owner";

const { app } = await import("../src/index.js");

test("auth session self-read audits success and unauthorized attempts", async () => {
  const token = await loginToken();
  const successResponse = await app.request("/api/v1/auth/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  const deniedResponse = await app.request("/api/v1/auth/me");
  const successAudit = await firstAuditEvent(token, "auth.me.read.succeeded", "succeeded");
  const deniedAudit = await firstAuditEvent(token, "auth.me.read.failed", "denied");

  assert.equal(successResponse.status, 200);
  assert.equal(deniedResponse.status, 401);
  assert.equal(successAudit?.actor.id, successAudit?.target.id);
  assert.equal(successAudit?.target.name, "admin@rakkr.local");
  assert.equal(deniedAudit?.actor.id, "anonymous");
  assert.equal(deniedAudit?.reason, "unauthorized");
  assert.equal(deniedAudit?.target.type, "user");
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

async function firstAuditEvent(token: string, action: string, outcome: string) {
  const query = new URLSearchParams({ action, outcome });
  const response = await app.request(`/api/v1/audit-events?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { data: AuditEvent[] };

  assert.equal(response.status, 200);

  return body.data[0];
}
