import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// The real login flow (openid-client) refuses non-TLS issuers unless this seam is
// explicitly enabled for a loopback issuer, which is exactly the fake provider.
process.env.RAKKR_OIDC_ALLOW_INSECURE_ISSUER = "1";

const { createOidcTestApp, driveOidcLogin, startFakeOidcProvider } =
  await import("./helpers/oidc-provider-harness.js");

let provider: Awaited<ReturnType<typeof startFakeOidcProvider>>;

before(async () => {
  provider = await startFakeOidcProvider();
});

after(async () => {
  await provider.stop();
});

test("completes a real OIDC login end to end into a Rakkr bearer session", async () => {
  provider.setClaims({
    email: "Ada@Example.com",
    groups: ["room-council"],
    name: "Ada Lovelace",
    oid: "azure-object-id",
    roles: ["operator"],
    sub: "subject-real-1",
  });
  const { app, auditActions, authService } = createOidcTestApp(provider);

  const { callbackResponse, location, token } = await driveOidcLogin(app, {
    returnTo: "/recordings",
  });

  assert.equal(callbackResponse.status, 302);
  assert.equal(location?.origin, "http://localhost:5173");
  assert.equal(location?.pathname, "/recordings");
  assert.ok(token, "callback should mint a bearer token");

  const auth = await authService.authenticate(`Bearer ${token}`);

  assert.equal(auth.user?.provider, "oidc");
  assert.equal(auth.user?.email, "ada@example.com");
  assert.ok(auth.user?.permissions.includes("recording:control"));
  assert.deepEqual(
    auth.user?.groups.map((group) => group.id),
    ["room-council"],
  );
  assert.deepEqual(auth.user?.roles, ["operator"]);
  assert.ok(auditActions.includes("auth.oidc.login.started"));
  assert.ok(auditActions.includes("auth.oidc.callback.succeeded"));
});

test("rejects a real login whose id_token has no email identity", async () => {
  provider.setClaims({ name: "No Email", sub: "subject-real-2" });
  const { app, auditActions } = createOidcTestApp(provider);

  const { callbackResponse, token } = await driveOidcLogin(app);
  const body = (await callbackResponse.json()) as { reason?: string };

  assert.equal(callbackResponse.status, 401);
  assert.equal(body.reason, "invalid_oidc_claims");
  assert.equal(token, undefined);
  assert.ok(auditActions.includes("auth.oidc.callback.failed"));
});

test("honors known role claims and drops unknown ones over the real token", async () => {
  provider.setClaims({
    email: "role-test@example.com",
    roles: ["operator", "Owner", "superadmin"],
    sub: "subject-real-3",
  });
  const { app, authService } = createOidcTestApp(provider);

  const { token } = await driveOidcLogin(app);
  const auth = await authService.authenticate(`Bearer ${token}`);

  // Only the exact, known role string survives — case variants and unknown roles
  // (which could otherwise escalate privilege) are discarded.
  assert.deepEqual(auth.user?.roles, ["operator"]);
});

test("re-syncs the same subject's email login into one stable user", async () => {
  const authService = new (await import("../src/auth-service.js")).LocalAuthService("");

  provider.setClaims({ email: "grace@example.com", name: "Grace", sub: "subject-real-4" });
  const first = createOidcTestApp(provider, { authService });
  const firstResult = await driveOidcLogin(first.app);
  const firstAuth = await authService.authenticate(`Bearer ${firstResult.token}`);

  provider.setClaims({ email: "Grace@example.com", name: "Grace Hopper", sub: "subject-real-4" });
  const second = createOidcTestApp(provider, { authService });
  const secondResult = await driveOidcLogin(second.app);
  const secondAuth = await authService.authenticate(`Bearer ${secondResult.token}`);

  assert.equal(secondAuth.user?.id, firstAuth.user?.id);
  assert.equal(secondAuth.user?.name, "Grace Hopper");
  const users = await authService.localUsers();

  assert.equal(users.filter((user) => user.email === "grace@example.com").length, 1);
});
