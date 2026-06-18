import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

const { registerAuthOidcRoutes } = await import("../src/auth-oidc-routes.js");
const { fetchOidcDiscovery, oidcConfigFromEnv, publicOidcConfig } =
  await import("../src/oidc-config.js");

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
    requirePermission: () => async (_c, next) => next(),
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
