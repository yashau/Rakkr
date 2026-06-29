import { randomBytes } from "node:crypto";
import { and, createDatabase, eq, gt, isNull, nodeBootstrapTokens } from "@rakkr/db";

import { hashToken, isUuid } from "./auth-utils.js";

const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 86_400;

export interface BootstrapTokenEnvelope {
  expiresAt: string;
  nodeId: string;
  token: string;
  tokenPrefix: string;
}

export class NodeBootstrapStoreError extends Error {
  constructor(
    message: string,
    readonly code: "database_unavailable",
  ) {
    super(message);
  }
}

export interface NodeBootstrapStore {
  /** Atomically consume a single-use, unexpired bootstrap token for a node. */
  consume(nodeId: string, token: string): Promise<boolean>;
  issue(
    nodeId: string,
    options?: { actorUserId?: string; ttlSeconds?: number },
  ): Promise<BootstrapTokenEnvelope>;
}

export function createNodeBootstrapStore(
  databaseUrl = process.env.DATABASE_URL,
): NodeBootstrapStore {
  return databaseUrl ? new PostgresNodeBootstrapStore(databaseUrl) : new UnavailableStore();
}

class UnavailableStore implements NodeBootstrapStore {
  async consume() {
    return false;
  }

  async issue(): Promise<BootstrapTokenEnvelope> {
    throw new NodeBootstrapStoreError(
      "Node bootstrap tokens require Postgres",
      "database_unavailable",
    );
  }
}

class PostgresNodeBootstrapStore implements NodeBootstrapStore {
  private readonly db;

  constructor(databaseUrl: string) {
    this.db = createDatabase(databaseUrl);
  }

  async issue(nodeId: string, options: { actorUserId?: string; ttlSeconds?: number } = {}) {
    const ttlSeconds = clampTtl(options.ttlSeconds);
    const token = `rakkr_bs_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const [row] = await this.db
      .insert(nodeBootstrapTokens)
      .values({
        createdByUserId:
          options.actorUserId && isUuid(options.actorUserId) ? options.actorUserId : null,
        expiresAt,
        nodeId,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 24),
      })
      .returning({
        expiresAt: nodeBootstrapTokens.expiresAt,
        tokenPrefix: nodeBootstrapTokens.tokenPrefix,
      });

    return {
      expiresAt: row.expiresAt.toISOString(),
      nodeId,
      token,
      tokenPrefix: row.tokenPrefix,
    };
  }

  async consume(nodeId: string, token: string) {
    const now = new Date();
    // Single atomic UPDATE: consumedAt is set only if the token is still unused
    // and unexpired, so a replay (or concurrent call) finds no matching row.
    const updated = await this.db
      .update(nodeBootstrapTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(nodeBootstrapTokens.nodeId, nodeId),
          eq(nodeBootstrapTokens.tokenHash, hashToken(token)),
          isNull(nodeBootstrapTokens.consumedAt),
          gt(nodeBootstrapTokens.expiresAt, now),
        ),
      )
      .returning({ id: nodeBootstrapTokens.id });

    return updated.length > 0;
  }
}

function clampTtl(ttlSeconds: number | undefined) {
  if (!ttlSeconds || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_TTL_SECONDS;
  }

  return Math.min(Math.floor(ttlSeconds), MAX_TTL_SECONDS);
}
