import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://rakkr:rakkr@127.0.0.1:5432/rakkr";

const baseUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
const probeDatabase = `rakkr_drizzle_verify_${randomUUID().replaceAll("-", "_")}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";

const admin = postgres(adminUrl.toString(), { max: 1 });

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function runMigration(probeUrl) {
  const pnpmEntrypoint = process.env.npm_execpath;
  const command = pnpmEntrypoint ? process.execPath : "pnpm";
  const args = pnpmEntrypoint ? [pnpmEntrypoint, "db:migrate"] : ["db:migrate"];
  const result = spawnSync(command, args, {
    env: { ...process.env, DATABASE_URL: probeUrl.toString() },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Drizzle migration replay failed with exit code ${result.status ?? 1}`);
  }
}

try {
  await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(probeDatabase)}`);

  const probeUrl = new URL(baseUrl);
  probeUrl.pathname = `/${probeDatabase}`;

  runMigration(probeUrl);
  console.log(`Verified Drizzle migrations against ${probeDatabase}.`);
} finally {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(probeDatabase)} WITH (FORCE)`);
  await admin.end();
}
