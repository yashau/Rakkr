import type { Hono } from "hono";

import type { AppBindings, RequirePermission } from "./http-types.js";
import {
  fetchOidcDiscovery,
  oidcConfigFromEnv,
  OidcConfigError,
  publicOidcConfig,
  type FetchLike,
  type OidcRuntimeConfig,
} from "./oidc-config.js";

interface AuthOidcRouteDependencies {
  app: Hono<AppBindings>;
  configProvider?: () => OidcRuntimeConfig;
  discoveryFetcher?: FetchLike;
  requirePermission: RequirePermission;
}

export function registerAuthOidcRoutes({
  app,
  configProvider = oidcConfigFromEnv,
  discoveryFetcher,
  requirePermission,
}: AuthOidcRouteDependencies) {
  app.get("/api/v1/auth/oidc/config", (c) => c.json({ data: publicOidcConfig(configProvider()) }));

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

function statusForOidcError(error: OidcConfigError) {
  if (error.code === "oidc_disabled") {
    return 404;
  }

  if (error.code === "oidc_not_configured") {
    return 400;
  }

  return 502;
}
