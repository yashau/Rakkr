import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

const { registerAuthOidcRoutes } = await import("../src/auth-oidc-routes.js");
const { LocalAuthService } = await import("../src/auth-service.js");
const { fetchOidcDiscovery, oidcConfigFromEnv, publicOidcConfig } =
  await import("../src/oidc-config.js");
const { createOidcLoginStore } = await import("../src/oidc-login.js");

test("reports disabled OIDC config without secrets", () => {
  const config = publicOidcConfig(oidcConfigFromEnv({}));

  assert.equal(config.enabled, false);
  assert.equal(config.configured, false);
  assert.equal(config.loginAvailable, false);
  assert.equal(config.clientId, undefined);
  assert.deepEqual(config.missingFields, []);
});

test("derives Azure AD issuer and required fields from environment", () => {
  const config = oidcConfigFromEnv({
    RAKKR_OIDC_AZURE_TENANT_ID: "tenant-id",
    RAKKR_OIDC_CLIENT_ID: "client-id",
    RAKKR_OIDC_ENABLED: "true",
    RAKKR_OIDC_REDIRECT_URI: "https://rakkr.example.com/api/v1/auth/oidc/callback",
    RAKKR_OIDC_SCOPES: "openid profile email groups",
  });

  assert.equal(config.enabled, true);
  assert.equal(config.configured, true);
  assert.equal(config.loginAvailable, true);
  assert.equal(config.issuer, "https://login.microsoftonline.com/tenant-id/v2.0");
  assert.equal(
    config.discoveryUrl,
    "https://login.microsoftonline.com/tenant-id/v2.0/.well-known/openid-configuration",
  );
  assert.deepEqual(config.scopes, ["openid", "profile", "email", "groups"]);
});

test("fetches and sanitizes OIDC discovery documents", async () => {
  const config = oidcConfigFromEnv({
    RAKKR_OIDC_AZURE_TENANT_ID: "tenant-id",
    RAKKR_OIDC_CLIENT_ID: "client-id",
    RAKKR_OIDC_ENABLED: "1",
    RAKKR_OIDC_REDIRECT_URI: "https://rakkr.example.com/api/v1/auth/oidc/callback",
  });

  const discovery = await fetchOidcDiscovery(config, async () => ({
    json: async () => ({
      authorization_endpoint: "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize",
      issuer: "https://login.microsoftonline.com/tenant-id/v2.0",
      jwks_uri: "https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys",
      token_endpoint: "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
      userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
    }),
    ok: true,
    status: 200,
  }));

  assert.equal(
    discovery.authorizationEndpoint,
    "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize",
  );
  assert.equal(
    discovery.jwksUri,
    "https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys",
  );
});

test("exposes OIDC config and protected discovery routes", async () => {
  const app = new Hono();
  const config = oidcConfigFromEnv({
    RAKKR_OIDC_AZURE_TENANT_ID: "tenant-id",
    RAKKR_OIDC_CLIENT_ID: "client-id",
    RAKKR_OIDC_ENABLED: "1",
    RAKKR_OIDC_REDIRECT_URI: "https://rakkr.example.com/api/v1/auth/oidc/callback",
  });

  registerAuthOidcRoutes({
    app,
    authService: new LocalAuthService(""),
    configProvider: () => config,
    discoveryFetcher: async () => ({
      json: async () => ({
        authorization_endpoint: "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize",
        issuer: "https://login.microsoftonline.com/tenant-id/v2.0",
        jwks_uri: "https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys",
        token_endpoint: "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
      }),
      ok: true,
      status: 200,
    }),
    recordAuditEvent: async () => auditEvent("auth.oidc.test"),
    requirePermission: () => async (_c, next) => next(),
    sessionContext: () => ({}),
    webOrigin: "http://localhost:5173",
  });

  const configResponse = await app.request("/api/v1/auth/oidc/config");
  const discoveryResponse = await app.request("/api/v1/auth/oidc/discovery");

  assert.equal(configResponse.status, 200);
  assert.equal(discoveryResponse.status, 200);
  assert.equal((await configResponse.json()).data.configured, true);
  assert.equal(
    (await discoveryResponse.json()).data.tokenEndpoint,
    "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token",
  );
});

test("starts OIDC login with PKCE state cookie and provider redirect", async () => {
  const app = new Hono();
  const events = [];

  registerAuthOidcRoutes({
    app,
    authService: new LocalAuthService(""),
    configProvider: configuredOidcConfig,
    loginFlow: {
      async complete() {
        throw new Error("not used");
      },
      async start(_config, returnTo) {
        return {
          authorizationUrl: new URL("https://login.example.test/authorize?state=state-1"),
          session: {
            codeVerifier: "verifier",
            createdAt: new Date(),
            nonce: "nonce",
            returnTo,
            state: "state-1",
          },
        };
      },
    },
    loginStore: createOidcLoginStore(),
    recordAuditEvent: async (_c, input) => {
      events.push(input.action);
      return auditEvent(input.action);
    },
    requirePermission: () => async (_c, next) => next(),
    sessionContext: () => ({}),
    webOrigin: "http://localhost:5173",
  });

  const response = await app.request("/api/v1/auth/oidc/login?returnTo=/recordings");

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://login.example.test/authorize?state=state-1",
  );
  assert.match(response.headers.get("set-cookie") ?? "", /rakkr_oidc_state=state-1/);
  assert.deepEqual(events, ["auth.oidc.login.started"]);
});

test("completes OIDC callback into a Rakkr bearer session", async () => {
  const app = new Hono();
  const authService = new LocalAuthService("");
  const loginStore = createOidcLoginStore();

  registerAuthOidcRoutes({
    app,
    authService,
    configProvider: configuredOidcConfig,
    loginFlow: {
      async complete(_config, callbackUrl, session) {
        assert.equal(callbackUrl.searchParams.get("code"), "code-1");
        assert.equal(session.returnTo, "http://localhost:5173/recordings");

        return {
          groups: ["room-council"],
          name: "Ada Lovelace",
          preferred_username: "ada@example.com",
          roles: ["operator"],
          sub: "subject-id",
        };
      },
      async start(_config, returnTo) {
        return {
          authorizationUrl: new URL("https://login.example.test/authorize?state=state-2"),
          session: {
            codeVerifier: "verifier",
            createdAt: new Date(),
            nonce: "nonce",
            returnTo,
            state: "state-2",
          },
        };
      },
    },
    loginStore,
    recordAuditEvent: async () => auditEvent("auth.oidc.test"),
    requirePermission: () => async (_c, next) => next(),
    sessionContext: () => ({ ipAddress: "127.0.0.1" }),
    webOrigin: "http://localhost:5173",
  });

  const loginResponse = await app.request("/api/v1/auth/oidc/login?returnTo=/recordings");
  const cookie = /rakkr_oidc_state=([^;]+)/.exec(
    loginResponse.headers.get("set-cookie") ?? "",
  )?.[0];
  const callbackResponse = await app.request(
    "http://localhost/api/v1/auth/oidc/callback?state=state-2&code=code-1",
    {
      headers: { Cookie: cookie ?? "" },
    },
  );
  const location = new URL(callbackResponse.headers.get("location") ?? "");
  const token = new URLSearchParams(location.hash.slice(1)).get("rakkr_token");
  const auth = await authService.authenticate(`Bearer ${token}`);

  assert.equal(callbackResponse.status, 302);
  assert.equal(location.origin, "http://localhost:5173");
  assert.equal(location.pathname, "/recordings");
  assert.equal(auth.user?.provider, "oidc");
  assert.equal(auth.user?.email, "ada@example.com");
  assert.ok(auth.user?.permissions.includes("recording:control"));
});

test("rejects OIDC callbacks that are not tied to the browser state cookie", async () => {
  const app = new Hono();

  registerAuthOidcRoutes({
    app,
    authService: new LocalAuthService(""),
    configProvider: configuredOidcConfig,
    loginFlow: {
      async complete() {
        throw new Error("not used");
      },
      async start() {
        throw new Error("not used");
      },
    },
    recordAuditEvent: async () => auditEvent("auth.oidc.test"),
    requirePermission: () => async (_c, next) => next(),
    sessionContext: () => ({}),
    webOrigin: "http://localhost:5173",
  });

  const response = await app.request("/api/v1/auth/oidc/callback?state=state-3&code=code-3");
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.reason, "oidc_state_invalid");
});

test("expires OIDC login state after the configured state TTL", async () => {
  const store = createOidcLoginStore(1);

  await store.save({
    codeVerifier: "verifier",
    createdAt: new Date(Date.now() - 10_000),
    nonce: "nonce",
    state: "expired-state",
  });

  assert.equal(await store.consume("expired-state"), undefined);
});

function configuredOidcConfig() {
  return oidcConfigFromEnv({
    RAKKR_OIDC_AZURE_TENANT_ID: "tenant-id",
    RAKKR_OIDC_CLIENT_ID: "client-id",
    RAKKR_OIDC_ENABLED: "1",
    RAKKR_OIDC_REDIRECT_URI: "https://rakkr.example.com/api/v1/auth/oidc/callback",
  });
}

function auditEvent(action) {
  return {
    action,
    actor: { id: "test", name: "Test", roles: [], type: "user" },
    actorContext: {},
    createdAt: new Date().toISOString(),
    details: {},
    id: `audit_${action}`,
    outcome: "succeeded",
    target: { type: "auth" },
  };
}
