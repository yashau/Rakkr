import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// The API pod's probes must be split by concern: readiness rides /readyz, which
// returns 503 while Postgres is unreachable, so Kubernetes keeps the pod OUT of
// the Service until the DB is actually usable. Liveness stays on the
// unconditional /healthz — a transient DB blip must not restart an otherwise
// healthy process into a crash-loop. Riding readiness on /healthz (its former
// state) marked the pod Ready with an unreachable database, which is the bug
// R33-API-READINESS fixes.

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const apiDeployment = await readFile(
  path.join(repoRoot, "deploy/helm/rakkr-controller/templates/api-deployment.yaml"),
  "utf8",
);

function probePath(kind: "livenessProbe" | "readinessProbe"): string {
  const match = new RegExp(`${kind}:\\s*\\n\\s*httpGet:\\s*\\n\\s*path:\\s*(\\S+)`, "u").exec(
    apiDeployment,
  );
  assert.ok(match, `API deployment must define ${kind}.httpGet.path`);

  return match[1];
}

test("API readiness probe targets /readyz so an unreachable DB keeps the pod out of the Service", () => {
  assert.equal(
    probePath("readinessProbe"),
    "/readyz",
    "readiness must ride /readyz (DB-aware), not the unconditional /healthz",
  );
});

test("API liveness probe stays on /healthz so a DB blip can't crash-loop a healthy process", () => {
  assert.equal(
    probePath("livenessProbe"),
    "/healthz",
    "liveness must ride /healthz (unconditional), not the DB-aware /readyz",
  );
});
