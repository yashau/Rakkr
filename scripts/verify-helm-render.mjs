// Render gate for the controller Helm chart. `helm template`s the chart across
// every secrets backend and asserts the invariants that keep a real install
// safe:
//   * the native backend renders an app Secret carrying the FULL key set
//     (all controller secrets + DATABASE_URL);
//   * the API consumes that Secret via envFrom.secretRef — never as a plaintext
//     `value:` in the Deployment (no key material baked into the pod spec);
//   * the two render-time `fail` guards fire for their bad combos
//     (orphaned bundled Postgres; migration Job against bundled Postgres).
//
// Self-skips cleanly (exit 0) when the `helm` binary is unavailable so a
// helm-less CI lane does not hard-fail.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chartDir = path.join(repoRoot, "deploy/helm/rakkr-controller");
const devValues = path.join(chartDir, "values-dev.yaml");

// Secrets the native app Secret must carry so the controller can boot with a
// full sensitive-env set (plus the DB URL it builds for bundled Postgres).
const requiredSecretKeys = [
  "RAKKR_SECRET_KEY",
  "RAKKR_NODE_SSH_MASTER_KEY",
  "RAKKR_RUNNER_TOKEN",
  "RAKKR_LOCAL_ADMIN_PASSWORD",
  "RAKKR_OIDC_CLIENT_SECRET",
  "DATABASE_URL",
];

function helmAvailable() {
  const probe = spawnSync("helm", ["version"], { encoding: "utf8" });

  return probe.status === 0 && !probe.error;
}

if (!helmAvailable()) {
  console.log("helm binary unavailable; skipping helm render gate.");
  process.exit(0);
}

// Run `helm template` and return { ok, output } (stdout+stderr merged) so we can
// assert on both successful renders and expected `fail` messages.
function helmTemplate(extraSets) {
  const args = [
    "template",
    "rakkr",
    chartDir,
    "-f",
    devValues,
    ...extraSets.flatMap((s) => ["--set", s]),
  ];
  const result = spawnSync("helm", args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  return { ok: result.status === 0, output };
}

// Extract the first rendered document matching `kind:` that also contains
// `contains`, or null.
function renderedDoc(output, kind, contains) {
  for (const doc of output.split(/\n---\n/u)) {
    if (new RegExp(`^kind:\\s*${kind}\\b`, "mu").test(doc) && doc.includes(contains)) {
      return doc;
    }
  }

  return null;
}

const errors = [];

// --- native backend: full key set + envFrom, no plaintext key material -------
{
  const { ok, output } = helmTemplate(["secrets.backend=native"]);

  if (!ok) {
    errors.push(`native backend must render; got:\n${output}`);
  } else {
    const appSecret = renderedDoc(output, "Secret", "DATABASE_URL");

    if (!appSecret) {
      errors.push("native backend must render an app Secret carrying DATABASE_URL");
    } else {
      for (const key of requiredSecretKeys) {
        if (!new RegExp(`^\\s*${key}:`, "mu").test(appSecret)) {
          errors.push(`native app Secret is missing required key ${key}`);
        }
      }
    }

    const apiDeployment = renderedDoc(output, "Deployment", "component: api");

    if (!apiDeployment) {
      errors.push("native backend must render the API Deployment");
    } else {
      if (!/envFrom:\s*(?:.*\n)*?\s*- secretRef:/u.test(apiDeployment)) {
        errors.push("API Deployment must consume the app Secret via envFrom.secretRef");
      }

      // No sensitive *_KEY must appear as an inline `value:` in the pod spec.
      const leak = /- name:\s*(RAKKR_\w*KEY\w*)\s*\n\s*value:/u.exec(apiDeployment);

      if (leak) {
        errors.push(`API Deployment leaks plaintext key material as a value: ${leak[1]}`);
      }
    }
  }
}

// --- externalSecrets + sealed backends still render + still use envFrom -------
for (const [backend, sets] of [
  ["externalSecrets", ["secrets.externalSecrets.secretStoreRef.name=verify-store"]],
  ["sealed", ["secrets.sealed.encryptedData.DATABASE_URL=AgVERIFYciphertext"]],
]) {
  const { ok, output } = helmTemplate([`secrets.backend=${backend}`, ...sets]);

  if (!ok) {
    errors.push(`${backend} backend must render; got:\n${output}`);
    continue;
  }

  const apiDeployment = renderedDoc(output, "Deployment", "component: api");

  if (!apiDeployment) {
    errors.push(`${backend} backend must render the API Deployment`);
  } else if (!/envFrom:\s*(?:.*\n)*?\s*- secretRef:/u.test(apiDeployment)) {
    errors.push(`${backend} backend API Deployment must consume the Secret via envFrom.secretRef`);
  }

  const kind = backend === "sealed" ? "SealedSecret" : "ExternalSecret";

  if (!renderedDoc(output, kind, "app")) {
    errors.push(`${backend} backend must render a ${kind} for the app secret`);
  }
}

// --- guard 1: orphaned bundled Postgres --------------------------------------
{
  const { ok, output } = helmTemplate([
    "postgres.enabled=true",
    "database.externalUrl=postgres://user:pw@db.example.com:5432/rakkr",
  ]);

  if (ok) {
    errors.push("orphaned-Postgres combo must FAIL render but it rendered cleanly");
  } else if (!/disable the bundled Postgres/iu.test(output)) {
    errors.push("orphaned-Postgres guard fired but without its actionable message");
  }
}

// --- guard 2: migration Job requires an external DB --------------------------
{
  const { ok, output } = helmTemplate(["migrations.job.enabled=true"]);

  if (ok) {
    errors.push("migration-Job-with-bundled-Postgres combo must FAIL render but it rendered cleanly");
  } else if (!/requires postgres\.enabled=false/iu.test(output)) {
    errors.push("migration-Job guard fired but without its actionable message");
  }
}

if (errors.length > 0) {
  console.error("Helm render gate failed:");

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log("Verified Helm chart renders across native/externalSecrets/sealed backends and both fail guards fire.");
