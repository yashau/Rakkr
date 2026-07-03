import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  None,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
  type DiscoveryRequestOptions,
} from "openid-client";
import { createDatabase, eq, lte, oidcLoginStates } from "@rakkr/db";

import { hashToken } from "./auth-utils.js";
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
  consume(state: string): Promise<OidcLoginSession | undefined>;
  save(session: OidcLoginSession): Promise<void>;
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
    async consume(state) {
      const session = sessions.get(state);

      sessions.delete(state);
      pruneExpiredSessions(sessions, ttlMs);

      if (!session || Date.now() - session.createdAt.getTime() > ttlMs) {
        return undefined;
      }

      return session;
    },
    async save(session) {
      pruneExpiredSessions(sessions, ttlMs);
      sessions.set(session.state, session);
    },
  };
}

export function createPersistentOidcLoginStore(
  databaseUrl = process.env.DATABASE_URL,
  ttlMs = defaultStateTtlMs,
): OidcLoginStore {
  const memory = createOidcLoginStore(ttlMs);

  if (!databaseUrl) {
    return memory;
  }

  const db = createDatabase(databaseUrl);
  let dbAvailable = true;

  return {
    async consume(state) {
      if (!dbAvailable) {
        return memory.consume(state);
      }

      try {
        const [row] = await db
          .delete(oidcLoginStates)
          .where(eq(oidcLoginStates.stateHash, hashToken(state)))
          .returning();

        await prunePersistentSessions(db).catch(() => undefined);

        if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
          return undefined;
        }

        return {
          codeVerifier: row.codeVerifier,
          createdAt: row.createdAt,
          nonce: row.nonce,
          returnTo: row.returnTo ?? undefined,
          state,
        };
      } catch (error) {
        dbAvailable = false;
        console.warn("OIDC state persistence unavailable; using memory store", error);
        return memory.consume(state);
      }
    },
    async save(session) {
      await memory.save(session);

      if (!dbAvailable) {
        return;
      }

      try {
        await prunePersistentSessions(db).catch(() => undefined);
        await db
          .insert(oidcLoginStates)
          .values({
            codeVerifier: session.codeVerifier,
            createdAt: session.createdAt,
            expiresAt: new Date(session.createdAt.getTime() + ttlMs),
            nonce: session.nonce,
            returnTo: session.returnTo,
            stateHash: hashToken(session.state),
          })
          .onConflictDoUpdate({
            set: {
              codeVerifier: session.codeVerifier,
              consumedAt: null,
              createdAt: session.createdAt,
              expiresAt: new Date(session.createdAt.getTime() + ttlMs),
              nonce: session.nonce,
              returnTo: session.returnTo,
            },
            target: oidcLoginStates.stateHash,
          });
      } catch (error) {
        dbAvailable = false;
        console.warn("OIDC state persistence unavailable; using memory store", error);
      }
    },
  };
}

async function discoveredClient(config: OidcRuntimeConfig) {
  const metadata = {
    redirect_uris: [config.redirectUri ?? ""],
    response_types: ["code"],
  };
  const options = insecureIssuerOptions(config.issuer);

  return config.clientSecret
    ? discovery(
        new URL(config.issuer ?? ""),
        config.clientId ?? "",
        { ...metadata, client_secret: config.clientSecret },
        undefined,
        options,
      )
    : discovery(new URL(config.issuer ?? ""), config.clientId ?? "", metadata, None(), options);
}

// Permits HTTP (non-TLS) discovery/token/JWKS requests, but ONLY for a loopback
// issuer AND only when RAKKR_OIDC_ALLOW_INSECURE_ISSUER is explicitly enabled.
// This is the seam that lets the in-process fake OIDC provider run over http in
// tests; it can never relax transport security for a real remote issuer.
function insecureIssuerOptions(issuer: string | undefined): DiscoveryRequestOptions | undefined {
  if (!issuer || !isLoopbackHttpIssuer(issuer)) {
    return undefined;
  }

  const flag = process.env.RAKKR_OIDC_ALLOW_INSECURE_ISSUER?.trim().toLowerCase();

  if (!["1", "on", "true", "yes"].includes(flag ?? "")) {
    return undefined;
  }

  return { execute: [allowInsecureRequests] };
}

function isLoopbackHttpIssuer(issuer: string) {
  try {
    const url = new URL(issuer);

    return (
      url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

async function prunePersistentSessions(db: ReturnType<typeof createDatabase>) {
  await db.delete(oidcLoginStates).where(lte(oidcLoginStates.expiresAt, new Date()));
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
