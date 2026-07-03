import { Hono } from "hono";
import { Events, OAuth2Server, type MutableToken } from "oauth2-mock-server";
import type { AuditEvent } from "@rakkr/shared";

import { registerAuthOidcRoutes } from "../../src/auth-oidc-routes.js";
import { LocalAuthService } from "../../src/auth-service.js";
import type { RequirePermission } from "../../src/http-types.js";
import type { OidcRuntimeConfig } from "../../src/oidc-config.js";
import { createOidcLoginFlow, createOidcLoginStore } from "../../src/oidc-login.js";

// A real, in-process OpenID provider for tests. It serves live discovery/JWKS,
// signs real RS256 id_tokens, honours PKCE + nonce, and lets a test set the exact
// claim payload for the next login via `setClaims`. Combined with the real
// `createOidcLoginFlow`, this exercises the whole token-exchange + claim path
// (not a stubbed loginFlow), which is where group-collision bugs actually live.

export type FakeOidcClaims = Record<string, unknown>;

export interface FakeOidcProvider {
  clientId: string;
  issuer: string;
  redirectUri: string;
  config(overrides?: Partial<OidcRuntimeConfig>): OidcRuntimeConfig;
  setClaims(claims: FakeOidcClaims): void;
  stop(): Promise<void>;
}

const defaultClaims: FakeOidcClaims = {
  email: "ada@example.com",
  name: "Ada Lovelace",
  oid: "azure-object-id",
  sub: "subject-id",
  tid: "tenant-id",
};

export async function startFakeOidcProvider(options?: {
  clientId?: string;
  redirectUri?: string;
}): Promise<FakeOidcProvider> {
  const clientId = options?.clientId ?? "rakkr-test-client";
  const redirectUri = options?.redirectUri ?? "http://localhost/api/v1/auth/oidc/callback";
  const server = new OAuth2Server();

  await server.issuer.keys.generate("RS256");
  await server.start(undefined, "localhost");

  const issuer = server.issuer.url;

  if (!issuer) {
    throw new Error("fake OIDC provider failed to expose an issuer URL");
  }

  let claims: FakeOidcClaims = { ...defaultClaims };

  // Applied to every signed token; the id_token is what the login flow reads.
  // Keys set to `undefined` are removed so a test can model a missing claim.
  server.service.on(Events.BeforeTokenSigning, (token: MutableToken) => {
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined) {
        delete token.payload[key];
      } else {
        token.payload[key] = value;
      }
    }
  });

  return {
    clientId,
    issuer,
    redirectUri,
    config(overrides) {
      return {
        clientId,
        clientSecret: undefined,
        configured: true,
        discoveryUrl: `${issuer}/.well-known/openid-configuration`,
        enabled: true,
        issuer,
        loginAvailable: true,
        missingFields: [],
        provider: "azure_ad",
        redirectUri,
        scopes: ["openid", "profile", "email"],
        ...overrides,
      };
    },
    setClaims(next) {
      claims = { ...next };
    },
    async stop() {
      await server.stop();
    },
  };
}

export interface OidcTestApp {
  app: Hono;
  auditActions: string[];
  authService: LocalAuthService;
}

// Wires a Hono app with the REAL login flow (createOidcLoginFlow) pointed at the
// fake provider, plus pass-through audit/permission stubs — the shared setup for
// end-to-end OIDC tests.
export function createOidcTestApp(
  provider: FakeOidcProvider,
  options?: { authService?: LocalAuthService; configOverrides?: Partial<OidcRuntimeConfig> },
): OidcTestApp {
  const app = new Hono();
  const authService = options?.authService ?? new LocalAuthService("");
  const auditActions: string[] = [];

  registerAuthOidcRoutes({
    app,
    authService,
    configProvider: () => provider.config(options?.configOverrides),
    loginFlow: createOidcLoginFlow(),
    loginStore: createOidcLoginStore(),
    recordAuditEvent: async (_c, input) => {
      auditActions.push(input.action);
      return fakeAuditEvent(input.action, input.outcome, input.reason);
    },
    requirePermission: passThroughPermission(),
    sessionContext: () => ({ ipAddress: "127.0.0.1" }),
    webOrigin: "http://localhost:5173",
  });

  return { app, auditActions, authService };
}

function passThroughPermission(): RequirePermission {
  return () => async (_c, next) => next();
}

function fakeAuditEvent(action: string, outcome: string, reason?: string): AuditEvent {
  return {
    action,
    actor: { id: "test", name: "Test", roles: [], type: "user" },
    actorContext: {},
    createdAt: new Date().toISOString(),
    details: {},
    id: `audit_${action}`,
    outcome: outcome as AuditEvent["outcome"],
    reason,
    target: { type: "auth" },
  };
}

export interface OidcLoginDriveResult {
  callbackResponse: Response;
  location?: URL;
  token?: string;
}

// Runs the full browser dance against a Hono app wired with the real login flow:
//   GET /login  -> 302 to the fake IdP authorize endpoint (+ state cookie)
//   GET authorize (real HTTP) -> 302 back to the callback with code + state
//   GET /callback -> real token exchange, id_token validation, user sync
export async function driveOidcLogin(
  app: Hono,
  options?: { returnTo?: string },
): Promise<OidcLoginDriveResult> {
  const returnTo = options?.returnTo ?? "/recordings";
  const loginResponse = await app.request(
    `/api/v1/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`,
  );

  if (loginResponse.status !== 302) {
    throw new Error(`OIDC login expected 302 redirect, received ${loginResponse.status}`);
  }

  const authorizeUrl = loginResponse.headers.get("location");
  const stateCookie = /rakkr_oidc_state=[^;]+/.exec(
    loginResponse.headers.get("set-cookie") ?? "",
  )?.[0];

  if (!authorizeUrl || !stateCookie) {
    throw new Error("OIDC login did not return an authorize URL and state cookie");
  }

  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const callbackUrl = authorizeResponse.headers.get("location");

  if (!callbackUrl) {
    throw new Error("fake OIDC provider did not redirect back to the callback");
  }

  const callbackResponse = await app.request(callbackUrl, {
    headers: { Cookie: stateCookie },
  });
  const locationHeader = callbackResponse.headers.get("location");
  const location = locationHeader ? new URL(locationHeader) : undefined;
  const token = location
    ? (new URLSearchParams(location.hash.slice(1)).get("rakkr_token") ?? undefined)
    : undefined;

  return { callbackResponse, location, token };
}
