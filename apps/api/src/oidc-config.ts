import { oidcDiscoverySchema, type OidcDiscovery, type OidcPublicConfig } from "@rakkr/shared";

const defaultScopes = ["openid", "profile", "email"];

export interface OidcRuntimeConfig extends Omit<OidcPublicConfig, "loginAvailable"> {
  clientSecret?: string;
  loginAvailable: false;
}

export class OidcConfigError extends Error {
  constructor(
    message: string,
    readonly code:
      | "oidc_disabled"
      | "oidc_discovery_failed"
      | "oidc_invalid_discovery_document"
      | "oidc_not_configured",
  ) {
    super(message);
  }
}

export interface FetchLikeResponse {
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
}

export type FetchLike = (input: string | URL) => Promise<FetchLikeResponse>;

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcRuntimeConfig {
  const issuer = normalizedUrl(
    text(env.RAKKR_OIDC_ISSUER) ?? azureIssuer(text(env.RAKKR_OIDC_AZURE_TENANT_ID)),
  );
  const clientId = text(env.RAKKR_OIDC_CLIENT_ID);
  const redirectUri = normalizedUrl(text(env.RAKKR_OIDC_REDIRECT_URI));
  const enabled = enabledFlag(env.RAKKR_OIDC_ENABLED);
  const missingFields = enabled
    ? [
        issuer ? undefined : "issuer",
        clientId ? undefined : "clientId",
        redirectUri ? undefined : "redirectUri",
      ].filter((field): field is string => Boolean(field))
    : [];

  return {
    clientId,
    clientSecret: text(env.RAKKR_OIDC_CLIENT_SECRET),
    configured: enabled && missingFields.length === 0,
    discoveryUrl: issuer ? `${issuer}/.well-known/openid-configuration` : undefined,
    enabled,
    issuer,
    loginAvailable: false,
    missingFields,
    provider: "azure_ad",
    redirectUri,
    scopes: scopesFromEnv(env.RAKKR_OIDC_SCOPES),
  };
}

export function publicOidcConfig(config: OidcRuntimeConfig): OidcPublicConfig {
  return {
    clientId: config.clientId,
    configured: config.configured,
    discoveryUrl: config.discoveryUrl,
    enabled: config.enabled,
    issuer: config.issuer,
    loginAvailable: config.loginAvailable,
    missingFields: config.missingFields,
    provider: config.provider,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
  };
}

export async function fetchOidcDiscovery(
  config: OidcRuntimeConfig,
  fetcher: FetchLike = fetch,
): Promise<OidcDiscovery> {
  if (!config.enabled) {
    throw new OidcConfigError("OIDC is disabled", "oidc_disabled");
  }

  if (!config.configured || !config.discoveryUrl || !config.issuer) {
    throw new OidcConfigError("OIDC is not configured", "oidc_not_configured");
  }

  const response = await fetcher(config.discoveryUrl).catch((error: unknown) => {
    throw new OidcConfigError(
      error instanceof Error ? error.message : "OIDC discovery failed",
      "oidc_discovery_failed",
    );
  });

  if (!response.ok) {
    throw new OidcConfigError(
      `OIDC discovery returned HTTP ${response.status}`,
      "oidc_discovery_failed",
    );
  }

  const parsed = oidcDiscoverySchema.safeParse(discoveryPayload(await response.json()));

  if (!parsed.success || normalizedUrl(parsed.data.issuer) !== config.issuer) {
    throw new OidcConfigError(
      "OIDC discovery document is invalid",
      "oidc_invalid_discovery_document",
    );
  }

  return parsed.data;
}

function discoveryPayload(value: unknown) {
  const record = isRecord(value) ? value : {};

  return {
    authorizationEndpoint: record.authorization_endpoint,
    issuer: record.issuer,
    jwksUri: record.jwks_uri,
    tokenEndpoint: record.token_endpoint,
    userinfoEndpoint: record.userinfo_endpoint,
  };
}

function azureIssuer(tenantId: string | undefined) {
  return tenantId ? `https://login.microsoftonline.com/${tenantId}/v2.0` : undefined;
}

function enabledFlag(value: string | undefined) {
  return ["1", "on", "true", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizedUrl(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);

    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function scopesFromEnv(value: string | undefined) {
  const scopes = value
    ?.split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes?.length ? scopes : defaultScopes;
}

function text(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}
