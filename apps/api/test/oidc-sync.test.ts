import assert from "node:assert/strict";
import test from "node:test";

const { LocalAuthService, AuthError } = await import("../src/auth-service.js");
const { normalizeAzureAdOidcUser } = await import("../src/oidc-sync.js");

test("normalizes Azure AD OIDC claims into Rakkr access inputs", () => {
  const normalized = normalizeAzureAdOidcUser({
    claims: {
      groups: ["room-council", "site-main"],
      name: "Ada Lovelace",
      oid: "azure-object-id",
      preferred_username: "Ada@example.com",
      roles: ["operator", "not-a-rakkr-role"],
      sub: "subject-id",
      tid: "tenant-id",
    },
    groupIds: ["manual-group"],
    resourceGrants: [{ resourceId: "room_1", resourceType: "room" }],
  });

  assert.equal(normalized.email, "ada@example.com");
  assert.equal(normalized.externalId, "azure-object-id");
  assert.equal(normalized.name, "Ada Lovelace");
  assert.equal(normalized.tenantId, "tenant-id");
  assert.deepEqual(
    normalized.groups.map((group) => group.id),
    ["manual-group", "room-council", "site-main"],
  );
  assert.deepEqual(normalized.roles, ["operator"]);
  assert.deepEqual(normalized.resourceGrants, [{ resourceId: "room_1", resourceType: "room" }]);
});

test("syncs Azure AD OIDC users through the auth service", async () => {
  const authService = new LocalAuthService("");
  const created = await authService.syncAzureAdOidcUser({
    claims: {
      groups: ["room-council"],
      name: "Ada Lovelace",
      preferred_username: "Ada@example.com",
      roles: ["operator"],
      sub: "subject-id",
    },
  });
  const updated = await authService.syncAzureAdOidcUser({
    claims: {
      groups: ["room-board"],
      name: "Ada Byron",
      preferred_username: "ada@example.com",
      roles: ["viewer"],
      sub: "subject-id",
    },
  });
  const users = await authService.localUsers();

  assert.equal(created.provider, "oidc");
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, "Ada Byron");
  assert.deepEqual(
    updated.groups.map((group) => group.id),
    ["room-board"],
  );
  assert.deepEqual(updated.roles, ["viewer"]);
  assert.ok(updated.permissions.includes("recording:read"));
  assert.ok(users.some((user) => user.id === updated.id && user.provider === "oidc"));
});

test("rejects Azure AD OIDC claims without an email identity", async () => {
  const authService = new LocalAuthService("");

  await assert.rejects(
    () =>
      authService.syncAzureAdOidcUser({
        claims: {
          name: "No Email",
          sub: "subject-id",
        },
      }),
    (error) => error instanceof AuthError && error.code === "invalid_oidc_claims",
  );
});
