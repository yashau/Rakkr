import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import postgres from "postgres";

// DB-backed Node tests that need a real Postgres (skipped by the default
// in-memory suite). This provisions an isolated throwaway database on the
// configured server — same contract as db:verify: a Postgres must be reachable at
// DATABASE_URL — migrates it, runs the tagged test files against it with
// --test-force-exit (the api db client pool has no exposed close), then drops it.
// Add DB-gated test files here so they run as part of `mise run check`.
const dbBackedApiTests = [
  "test/oidc-groups-collision.test.ts",
  "test/node-ssh-credential-rotation-atomic.test.ts",
  "test/node-credential-rotation-atomic.test.ts",
  "test/node-metadata-write-race.test.ts",
];

const DEFAULT_DATABASE_URL = "postgres://rakkr:rakkr@127.0.0.1:5432/rakkr";
const baseUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
const probeDatabase = `rakkr_dbtest_${randomUUID().replaceAll("-", "_")}`;
const probeUrl = new URL(baseUrl);
probeUrl.pathname = `/${probeDatabase}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";

const admin = postgres(adminUrl.toString(), { max: 1 });

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function runPnpm(args, env) {
  // Invoke pnpm's JS entrypoint through node when available (no shell, so it
  // works identically on Windows and Linux CI); fall back to the pnpm binary.
  const pnpmEntrypoint = process.env.npm_execpath;
  const hasNodeEntrypoint =
    pnpmEntrypoint &&
    path.isAbsolute(pnpmEntrypoint) &&
    [".cjs", ".js", ".mjs"].includes(path.extname(pnpmEntrypoint));
  const command = hasNodeEntrypoint ? process.execPath : "pnpm";
  const commandArgs = hasNodeEntrypoint ? [pnpmEntrypoint, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

try {
  await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(probeDatabase)}`);

  runPnpm(["--filter", "@rakkr/db", "db:migrate"], { DATABASE_URL: probeUrl.toString() });
  runPnpm(
    ["--filter", "@rakkr/api", "exec", "tsx", "--test", "--test-force-exit", ...dbBackedApiTests],
    { DATABASE_URL: probeUrl.toString(), RAKKR_API_TEST_DATABASE_URL: probeUrl.toString() },
  );

  console.log(`Ran DB-backed Node tests against ${probeDatabase}.`);
} finally {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(probeDatabase)} WITH (FORCE)`);
  await admin.end();
}
