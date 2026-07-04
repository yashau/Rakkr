import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

// If an operator configures an external database (`database.externalUrl` or
// `database.existingSecret.name`) but leaves the default `postgres.enabled=true`,
// the chart renders a full bundled Postgres StatefulSet+Service+Secret+PVC that
// runs UNUSED — wasted storage, a second source of truth for the DB password,
// and a confusing "which Postgres am I actually using" footgun. The chart must
// `fail` at render time on that contradictory combo with a clear message, while
// still rendering the two sane combos (bundled-only; external + postgres
// disabled). This exercises the real `helm template` render.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const chartDir = path.join(repoRoot, "deploy/helm/rakkr-controller");
const devValues = path.join(chartDir, "values-dev.yaml");

// Render the chart via the mise-provided helm 3.16.3. Returns combined
// stdout/stderr and the exit status so tests can assert on failure text.
function helmTemplate(extraSets: string[]): { ok: boolean; output: string } {
  const args = [
    "x",
    "helm@3.16.3",
    "--",
    "helm",
    "template",
    "rakkr",
    chartDir,
    "-f",
    devValues,
    ...extraSets.flatMap((s) => ["--set", s]),
  ];
  const result = spawnSync("mise", args, { cwd: repoRoot, encoding: "utf8", shell: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  return { ok: result.status === 0, output };
}

const helmAvailable = (() => {
  const probe = spawnSync("mise", ["x", "helm@3.16.3", "--", "helm", "version"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
  });

  return probe.status === 0;
})();

test(
  "bundled-Postgres install renders cleanly (postgres.enabled=true, no external DB)",
  { skip: helmAvailable ? false : "helm 3.16.3 unavailable" },
  () => {
    const { ok, output } = helmTemplate(["postgres.enabled=true"]);
    assert.ok(ok, `bundled-only install must render; got:\n${output}`);
    assert.match(
      output,
      /kind:\s*StatefulSet/u,
      "bundled install should render the Postgres StatefulSet",
    );
  },
);

test(
  "external DB with bundled Postgres disabled renders cleanly",
  { skip: helmAvailable ? false : "helm 3.16.3 unavailable" },
  () => {
    const { ok, output } = helmTemplate([
      "postgres.enabled=false",
      "database.externalUrl=postgres://user:pw@db.example.com:5432/rakkr",
    ]);
    assert.ok(ok, `external + disabled bundled Postgres must render; got:\n${output}`);
    assert.doesNotMatch(
      output,
      /component:\s*postgres/u,
      "no bundled Postgres objects should render when postgres.enabled=false",
    );
  },
);

test(
  "external URL + enabled bundled Postgres FAILS render (orphaned Postgres guard)",
  { skip: helmAvailable ? false : "helm 3.16.3 unavailable" },
  () => {
    const { ok, output } = helmTemplate([
      "postgres.enabled=true",
      "database.externalUrl=postgres://user:pw@db.example.com:5432/rakkr",
    ]);
    assert.equal(ok, false, `orphaned-Postgres combo must fail render; got:\n${output}`);
    assert.match(
      output,
      /disable the bundled Postgres/iu,
      "the render failure must explain to disable the bundled Postgres",
    );
  },
);

test(
  "external existingSecret + enabled bundled Postgres FAILS render (orphaned Postgres guard)",
  { skip: helmAvailable ? false : "helm 3.16.3 unavailable" },
  () => {
    const { ok, output } = helmTemplate([
      "postgres.enabled=true",
      "database.existingSecret.name=rakkr-database",
    ]);
    assert.equal(ok, false, `orphaned-Postgres combo must fail render; got:\n${output}`);
    assert.match(
      output,
      /disable the bundled Postgres/iu,
      "the render failure must explain to disable the bundled Postgres",
    );
  },
);
