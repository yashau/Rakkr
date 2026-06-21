import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Permission } from "@rakkr/shared";

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
  createPersistentOidcLoginStore,
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

interface OidcActionState {
  enabled: boolean;
  href?: string;
  method: "GET";
  permission?: Permission;
  reason?: string;
}

const stateCookie = "rakkr_oidc_state";
const stateMaxAgeSeconds = 10 * 60;

export function clearOidcLoginStateCookie(c: Context<AppBindings>) {
  c.header(
    "Set-Cookie",
    `${stateCookie}=; Max-Age=0; Path=/api/v1/auth/oidc/callback; HttpOnly; SameSite=Lax`,
    {
      append: true,
    },
  );
}

export function registerAuthOidcRoutes({
  app,
  authService,
  configProvider = oidcConfigFromEnv,
  discoveryFetcher,
  loginFlow = createOidcLoginFlow(),
  loginStore = createPersistentOidcLoginStore(),
  recordAuditEvent,
  requirePermission,
  sessionContext,
  webOrigin,
}: AuthOidcRouteDependencies) {
  app.get("/api/v1/auth/oidc/config", (c) => c.json({ data: publicOidcConfig(configProvider()) }));

  app.get("/api/v1/auth/oidc/actions", (c) => {
    const config = configProvider();

    return c.json({
      data: {
        actions: oidcPublicActions(config),
        config: publicOidcConfig(config),
        links: oidcLinks(),
      },
    });
  });

  app.get("/api/v1/auth/oidc/login", async (c) => {
    const config = configProvider();

    try {
      const start = await loginFlow.start(config, safeReturnTo(c.req.query("returnTo"), webOrigin));

      await loginStore.save(start.session);
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

    clearOidcLoginStateCookie(c);

    if (!state || state !== cookieState) {
      await recordCallbackFailure(c, recordAuditEvent, "oidc_state_invalid");

      return c.json({ error: "OIDC callback state is invalid", reason: "oidc_state_invalid" }, 400);
    }

    const session = await loginStore.consume(state);

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
    "/api/v1/auth/oidc/discovery/actions",
    requirePermission("auth:manage", "auth.oidc.discovery.actions.read", () => ({ type: "auth" })),
    async (c) => {
      const config = configProvider();

      return c.json({
        data: {
          actions: oidcDiscoveryActions(config, c.get("auth")?.user?.permissions ?? []),
          config: publicOidcConfig(config),
          links: oidcLinks(),
        },
      });
    },
  );

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

function oidcPublicActions(config: OidcRuntimeConfig) {
  return {
    config: oidcActionState({
      href: "/api/v1/auth/oidc/config",
      method: "GET",
      ready: true,
    }),
    login: oidcActionState({
      href: "/api/v1/auth/oidc/login",
      method: "GET",
      ready: config.loginAvailable,
      reason: oidcUnavailableReason(config),
    }),
  };
}

function oidcDiscoveryActions(config: OidcRuntimeConfig, permissions: readonly Permission[]) {
  return {
    discovery: oidcActionState({
      href: "/api/v1/auth/oidc/discovery",
      method: "GET",
      permission: "auth:manage",
      permissions,
      ready: config.enabled && config.configured && Boolean(config.discoveryUrl),
      reason: oidcDiscoveryUnavailableReason(config),
    }),
  };
}

function oidcActionState({
  href,
  method,
  permission,
  permissions = [],
  ready,
  reason,
}: {
  href?: string;
  method: OidcActionState["method"];
  permission?: Permission;
  permissions?: readonly Permission[];
  ready: boolean;
  reason?: string;
}): OidcActionState {
  if (permission && !permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason };
}

function oidcLinks() {
  return {
    actions: "/api/v1/auth/oidc/actions",
    callback: "/api/v1/auth/oidc/callback",
    config: "/api/v1/auth/oidc/config",
    discovery: "/api/v1/auth/oidc/discovery",
    discoveryActions: "/api/v1/auth/oidc/discovery/actions",
    login: "/api/v1/auth/oidc/login",
  };
}

function oidcUnavailableReason(config: OidcRuntimeConfig) {
  if (!config.enabled) {
    return "oidc_disabled";
  }

  return config.configured ? undefined : "oidc_not_configured";
}

function oidcDiscoveryUnavailableReason(config: OidcRuntimeConfig) {
  if (!config.enabled) {
    return "oidc_disabled";
  }

  if (!config.configured || !config.discoveryUrl) {
    return "oidc_not_configured";
  }

  return undefined;
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
