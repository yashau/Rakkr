import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Database = ReturnType<typeof drizzle>;

const PGLITE_URL_PREFIX = "pglite://";

// In-process PGlite (WASM Postgres) databases created by createPgliteDatabase(),
// keyed by the sentinel URL handed back to the caller. createDatabase() resolves
// those URLs to the shared instance, so every store and service in the process
// reuses one migrated database — mirroring how the postgres-js pools all reach a
// single server.
const pgliteRegistry = new Map<string, Database>();

export function createDatabase(databaseUrl: string): Database {
  if (databaseUrl.startsWith(PGLITE_URL_PREFIX)) {
    const registered = pgliteRegistry.get(databaseUrl);

    if (!registered) {
      throw new Error(
        `PGlite database "${databaseUrl}" is not initialized; call createPgliteDatabase() before createDatabase().`,
      );
    }

    return registered;
  }

  const client = postgres(databaseUrl, { max: 3 });

  return drizzle(client);
}

export async function closeDatabase(database: Database) {
  await database.$client.end();
}

export interface PgliteDatabaseHandle {
  /** Sentinel DATABASE_URL that createDatabase() resolves to this instance. */
  url: string;
  /** Drop the instance from the registry and release its resources. */
  close(): Promise<void>;
}

/**
 * Provision an in-process PGlite (WASM Postgres) database, apply the Drizzle
 * migrations, and register it so createDatabase(url) — and therefore every store
 * and LocalAuthService in this process — resolves to it. This lets tests exercise
 * the real Postgres SQL path without a running server.
 *
 * PGlite is loaded via dynamic import so it never enters the production
 * postgres-js path. It is single-connection, so it is deliberately NOT a
 * substitute for tests that require genuine concurrent connections (row-lock /
 * atomic compare-and-set races) — those keep a real Postgres.
 */
export async function createPgliteDatabase(label = "test"): Promise<PgliteDatabaseHandle> {
  const [{ PGlite }, { drizzle: pgliteDrizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);

  const client = new PGlite();
  const db = pgliteDrizzle(client);
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });

  const url = `${PGLITE_URL_PREFIX}${label}-${randomUUID()}`;
  // The PGlite driver exposes the same query builders as postgres-js drizzle, so
  // the stores treat it identically; the surface differences (the underlying
  // client, migrations) are handled here, not by callers.
  pgliteRegistry.set(url, db as unknown as Database);

  return {
    url,
    async close() {
      pgliteRegistry.delete(url);
      await client.close();
    },
  };
}

export { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNull, lte, or, sql, type SQL };
