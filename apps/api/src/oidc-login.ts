import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  None,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";

import { azureAdOidcClaimsSchema, type AzureAdOidcClaims } from "./oidc-sync.js";
import { OidcConfigError, type OidcRuntimeConfig } from "./oidc-config.js";

const defaultStateTtlMs = 10 * 60 * 1000;

export interface OidcLoginSession {
  codeVerifier: string;
  createdAt: Date;
  nonce: string;
  returnTo?: string;
  state: string;
}

export interface OidcLoginStart {
  authorizationUrl: URL;
  session: OidcLoginSession;
}

export interface OidcLoginFlow {
  complete(
    config: OidcRuntimeConfig,
    callbackUrl: URL,
    session: OidcLoginSession,
  ): Promise<AzureAdOidcClaims>;
  start(config: OidcRuntimeConfig, returnTo?: string): Promise<OidcLoginStart>;
}

export interface OidcLoginStore {
  consume(state: string): OidcLoginSession | undefined;
  save(session: OidcLoginSession): void;
}

export class OidcLoginError extends Error {
  constructor(
    message: string,
    readonly code: "oidc_authorization_failed" | "oidc_claims_invalid" | "oidc_state_invalid",
  ) {
    super(message);
  }
}

export function createOidcLoginFlow(): OidcLoginFlow {
  let cachedClient: Promise<Configuration> | undefined;
  let cachedKey: string | undefined;

  async function clientConfig(config: OidcRuntimeConfig) {
    requireUsableConfig(config);

    const key = `${config.issuer}|${config.clientId}|${config.redirectUri}|${Boolean(config.clientSecret)}`;

    if (!cachedClient || cachedKey !== key) {
      cachedKey = key;
      cachedClient = discoveredClient(config);
    }

    return cachedClient;
  }

  return {
    async complete(config, callbackUrl, session) {
      const tokens = await authorizationCodeGrant(await clientConfig(config), callbackUrl, {
        expectedNonce: session.nonce,
        expectedState: session.state,
        idTokenExpected: true,
        pkceCodeVerifier: session.codeVerifier,
      }).catch((error: unknown) => {
        throw new OidcLoginError(
          error instanceof Error ? error.message : "OIDC authorization failed",
          "oidc_authorization_failed",
        );
      });
      const claims = azureAdOidcClaimsSchema.safeParse(tokens.claims());

      if (!claims.success) {
        throw new OidcLoginError("OIDC ID token claims are invalid", "oidc_claims_invalid");
      }

      return claims.data;
    },
    async start(config, returnTo) {
      const client = await clientConfig(config);
      const codeVerifier = randomPKCECodeVerifier();
      const state = randomState();
      const nonce = randomNonce();
      const authorizationUrl = buildAuthorizationUrl(client, {
        code_challenge: await calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        nonce,
        redirect_uri: config.redirectUri ?? "",
        scope: config.scopes.join(" "),
        state,
      });

      return {
        authorizationUrl,
        session: {
          codeVerifier,
          createdAt: new Date(),
          nonce,
          returnTo,
          state,
        },
      };
    },
  };
}

export function createOidcLoginStore(ttlMs = defaultStateTtlMs): OidcLoginStore {
  const sessions = new Map<string, OidcLoginSession>();

  return {
    consume(state) {
      const session = sessions.get(state);

      sessions.delete(state);
      pruneExpiredSessions(sessions, ttlMs);

      if (!session || Date.now() - session.createdAt.getTime() > ttlMs) {
        return undefined;
      }

      return session;
    },
    save(session) {
      pruneExpiredSessions(sessions, ttlMs);
      sessions.set(session.state, session);
    },
  };
}

async function discoveredClient(config: OidcRuntimeConfig) {
  const metadata = {
    redirect_uris: [config.redirectUri ?? ""],
    response_types: ["code"],
  };

  return config.clientSecret
    ? discovery(new URL(config.issuer ?? ""), config.clientId ?? "", {
        ...metadata,
        client_secret: config.clientSecret,
      })
    : discovery(new URL(config.issuer ?? ""), config.clientId ?? "", metadata, None());
}

function pruneExpiredSessions(sessions: Map<string, OidcLoginSession>, ttlMs: number) {
  const now = Date.now();

  for (const [state, session] of sessions) {
    if (now - session.createdAt.getTime() > ttlMs) {
      sessions.delete(state);
    }
  }
}

function requireUsableConfig(config: OidcRuntimeConfig) {
  if (!config.enabled) {
    throw new OidcConfigError("OIDC is disabled", "oidc_disabled");
  }

  if (!config.configured || !config.clientId || !config.issuer || !config.redirectUri) {
    throw new OidcConfigError("OIDC is not configured", "oidc_not_configured");
  }
}
