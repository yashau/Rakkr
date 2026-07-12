import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// Replays the full Drizzle migration set against an in-process PGlite (WASM
// Postgres) database. This validates that the committed migrations apply cleanly
// from an empty schema with no Docker/Postgres server — so it runs on any dev
// machine and in CI without provisioning.
//
// Note: PGlite is a real Postgres build, so migration DDL fidelity is high, but it
// is NOT the exact server version production runs. The concurrency harness
// (scripts/run-db-integration-tests.mjs) still applies these same migrations
// against a real Postgres via drizzle-kit before its tests, so real-server
// migration application stays covered in CI.
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const client = new PGlite();
const db = drizzle(client);

try {
  await migrate(db, { migrationsFolder });
  console.log("Verified Drizzle migrations against in-process PGlite.");
} finally {
  await client.close();
}
