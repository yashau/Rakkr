import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { LocalAuthService, LoginResult, SessionContext } from "./auth-service.js";
import type { AppBindings, RequirePermission } from "./http-types.js";
import type { RecordAuditEvent } from "./http-types.js";
import {
  fetchOidcDiscovery,
  oidcConfigFromEnv,
  OidcConfigError,
  publicOidcConfig,
  type FetchLike,
  type OidcRuntimeConfig,
} from "./oidc-config.js";
import {
  createOidcLoginFlow,
  createOidcLoginStore,
  OidcLoginError,
  type OidcLoginFlow,
  type OidcLoginStore,
} from "./oidc-login.js";

interface AuthOidcRouteDependencies {
  app: Hono<AppBindings>;
  authService: LocalAuthService;
  configProvider?: () => OidcRuntimeConfig;
  discoveryFetcher?: FetchLike;
  loginFlow?: OidcLoginFlow;
  loginStore?: OidcLoginStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  sessionContext: (c: Parameters<RecordAuditEvent>[0]) => SessionContext;
  webOrigin: string;
}

const stateCookie = "rakkr_oidc_state";
const stateMaxAgeSeconds = 10 * 60;

export function registerAuthOidcRoutes({
  app,
  authService,
  configProvider = oidcConfigFromEnv,
  discoveryFetcher,
  loginFlow = createOidcLoginFlow(),
  loginStore = createOidcLoginStore(),
  recordAuditEvent,
  requirePermission,
  sessionContext,
  webOrigin,
}: AuthOidcRouteDependencies) {
  app.get("/api/v1/auth/oidc/config", (c) => c.json({ data: publicOidcConfig(configProvider()) }));

  app.get("/api/v1/auth/oidc/login", async (c) => {
    const config = configProvider();

    try {
      const start = await loginFlow.start(config, safeReturnTo(c.req.query("returnTo"), webOrigin));

      loginStore.save(start.session);
      setCookie(c, stateCookie, start.session.state, {
        httpOnly: true,
        maxAge: stateMaxAgeSeconds,
        path: "/api/v1/auth/oidc/callback",
        sameSite: "Lax",
        secure: config.redirectUri?.startsWith("https://"),
      });

      await recordAuditEvent(c, {
        action: "auth.oidc.login.started",
        details: { issuer: config.issuer },
        outcome: "succeeded",
        target: { type: "auth" },
      });

      return c.redirect(start.authorizationUrl.href);
    } catch (error) {
      const reason = oidcErrorReason(error);

      await recordAuditEvent(c, {
        action: "auth.oidc.login.failed",
        outcome: "failed",
        reason,
        target: { type: "auth" },
      });

      return c.json({ error: "OIDC login unavailable", reason }, statusForOidcReason(reason));
    }
  });

  app.get("/api/v1/auth/oidc/callback", async (c) => {
    const state = c.req.query("state");
    const cookieState = getCookie(c, stateCookie);

    deleteCookie(c, stateCookie, { path: "/api/v1/auth/oidc/callback" });

    if (!state || state !== cookieState) {
      await recordCallbackFailure(c, recordAuditEvent, "oidc_state_invalid");

      return c.json({ error: "OIDC callback state is invalid", reason: "oidc_state_invalid" }, 400);
    }

    const session = loginStore.consume(state);

    if (!session) {
      await recordCallbackFailure(c, recordAuditEvent, "oidc_state_invalid");

      return c.json({ error: "OIDC callback state is invalid", reason: "oidc_state_invalid" }, 400);
    }

    try {
      const claims = await loginFlow.complete(configProvider(), new URL(c.req.url), session);
      const user = await authService.syncAzureAdOidcUser({ claims });
      const login = await authService.createSession(user, sessionContext(c));

      await recordAuditEvent(c, {
        action: "auth.oidc.callback.succeeded",
        auth: { sessionId: login.sessionId, user: login.user },
        outcome: "succeeded",
        target: { id: login.user.id, name: login.user.email, type: "user" },
      });

      return c.redirect(callbackRedirect(login, session.returnTo ?? webOrigin));
    } catch (error) {
      const reason = oidcErrorReason(error);

      await recordCallbackFailure(c, recordAuditEvent, reason);

      return c.json({ error: "OIDC callback failed", reason }, statusForOidcReason(reason));
    }
  });

  app.get(
    "/api/v1/auth/oidc/discovery",
    requirePermission("auth:manage", "auth.oidc.discovery.read", () => ({ type: "auth" })),
    async (c) => {
      try {
        const discovery = await fetchOidcDiscovery(configProvider(), discoveryFetcher);

        return c.json({ data: discovery });
      } catch (error) {
        if (error instanceof OidcConfigError) {
          return c.json({ error: error.message, reason: error.code }, statusForOidcError(error));
        }

        return c.json({ error: "OIDC discovery failed", reason: "unknown_oidc_error" }, 502);
      }
    },
  );
}

async function recordCallbackFailure(
  c: Parameters<RecordAuditEvent>[0],
  recordAuditEvent: RecordAuditEvent,
  reason: string,
) {
  await recordAuditEvent(c, {
    action: "auth.oidc.callback.failed",
    outcome: "failed",
    reason,
    target: { type: "auth" },
  });
}

function callbackRedirect(login: LoginResult, returnTo: string) {
  const url = new URL(returnTo);

  url.hash = new URLSearchParams({
    rakkr_expires_at: login.expiresAt,
    rakkr_provider: login.user.provider,
    rakkr_token: login.token,
  }).toString();

  return url.href;
}

function oidcErrorReason(error: unknown) {
  if (error instanceof OidcConfigError || error instanceof OidcLoginError) {
    return error.code;
  }

  return "unknown_oidc_error";
}

function safeReturnTo(value: string | undefined, fallback: string) {
  const fallbackUrl = new URL(fallback);

  if (!value) {
    return fallbackUrl.href;
  }

  try {
    const url =
      value.startsWith("/") && !value.startsWith("//")
        ? new URL(value, fallbackUrl)
        : new URL(value);

    return url.origin === fallbackUrl.origin ? url.href : fallbackUrl.href;
  } catch {
    return fallbackUrl.href;
  }
}

function statusForOidcReason(reason: string) {
  if (reason === "oidc_disabled") {
    return 404;
  }

  if (reason === "oidc_not_configured" || reason === "oidc_state_invalid") {
    return 400;
  }

  if (reason === "oidc_claims_invalid" || reason === "invalid_oidc_claims") {
    return 401;
  }

  return 502;
}

function statusForOidcError(error: OidcConfigError) {
  if (error.code === "oidc_disabled") {
    return 404;
  }

  if (error.code === "oidc_not_configured") {
    return 400;
  }

  return 502;
}
