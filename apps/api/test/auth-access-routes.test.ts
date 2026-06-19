import assert from "node:assert/strict";
import test from "node:test";
import type { AccessPolicy, AccessPolicyInput, AuditEvent } from "@rakkr/shared";

process.env.DATABASE_URL = "";
process.env.RAKKR_API_NO_LISTEN = "1";
process.env.RAKKR_LOCAL_ACCESS_POLICIES = "";

const { app } = await import("../src/index.js");

test("access policy updates audit before and after snapshots", async () => {
  const token = await loginToken();
  const policies = [
    {
      effect: "deny",
      reason: "room_maintenance",
      resourceId: "node_room_alpha",
      resourceType: "node",
      subjectType: "everyone",
    },
  ];

  const response = await updateAccessPolicies(token, policies);
  const body = (await response.json()) as { data: AccessPolicy[] };
  const eventsResponse = await app.request(
    "/api/v1/audit-events?action=auth.access_policies.update.succeeded",
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
  const [event] = eventsBody.data;

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]?.effect, "deny");
  assert.equal(eventsResponse.status, 200);
  assert.equal(event?.permission, "auth:manage");
  assert.equal(event?.target.type, "auth");
  assert.deepEqual(event?.before, { policies: [] });
  assert.equal(
    (event?.after?.policies as AccessPolicy[] | undefined)?.[0]?.reason,
    "room_maintenance",
  );
});

test("recording resource denies block metadata edits and audit the denial", async () => {
  const token = await loginToken();
  const recordingId = "rec_demo_001";

  await updateAccessPolicies(token, [
    {
      effect: "deny",
      reason: "sealed_room",
      resourceId: recordingId,
      resourceType: "recording",
      subjectType: "everyone",
    },
  ]);

  try {
    const response = await app.request(`/api/v1/recordings/${recordingId}/metadata`, {
      body: JSON.stringify({ name: "Blocked Rename" }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "PATCH",
    });
    const eventsResponse = await app.request(
      [
        "/api/v1/audit-events",
        "?action=recordings.metadata.update",
        "&outcome=denied",
        "&permission=recording%3Aedit",
        `&target=${recordingId}`,
      ].join(""),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const eventsBody = (await eventsResponse.json()) as { data: AuditEvent[] };
    const [event] = eventsBody.data;

    assert.equal(response.status, 403);
    assert.equal(eventsResponse.status, 200);
    assert.equal(event?.permission, "recording:edit");
    assert.equal(event?.reason, "access_policy_denied");
    assert.equal(event?.target.id, recordingId);
    assert.equal(event?.target.type, "recording");
    assert.equal(event?.details.resourceScopeDecision, "access_policy_denied");
  } finally {
    await updateAccessPolicies(token, []);
  }
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

async function updateAccessPolicies(token: string, policies: AccessPolicyInput[]) {
  return app.request("/api/v1/auth/access-policies", {
    body: JSON.stringify({ policies }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "PATCH",
  });
}
