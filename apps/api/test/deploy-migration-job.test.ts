import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

// The opt-in migration Job (migrations.job.enabled=true) is for an EXTERNAL /
// pre-existing database only. It runs as a pre-install/pre-upgrade Helm hook,
// which is applied BEFORE the release's normal resources — so the bundled
// Postgres StatefulSet isn't up yet when the hook fires. This exercises the real
// `helm template` render and asserts the coherent design:
//   * job enabled + external DB: the Job renders WITH the sequencing hook
//     annotations + a wait-for-database initContainer, AND the API Deployment
//     has NO migrate initContainer (enabling the Job disables the init-migrate,
//     so there is no double-migrate);
//   * job enabled + bundled Postgres: render FAILS with the guard message
//     (bundled installs must use the default init-container migrate);
//   * default (job disabled, bundled): the API init-migrate still renders.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const chartDir = path.join(repoRoot, "deploy/helm/rakkr-controller");
const devValues = path.join(chartDir, "values-dev.yaml");

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

// Extract a single rendered document by `kind:` and a substring that must appear
// in it. Returns the document body, or null when no such document renders.
function renderedDoc(output: string, kind: string, contains: string): string | null {
  for (const doc of output.split(/\n---\n/u)) {
    if (new RegExp(`^kind:\\s*${kind}\\b`, "mu").test(doc) && doc.includes(contains)) {
      return doc;
    }
  }

  return null;
}

test(
  "job enabled + external DB: Job renders with hook + wait-for-database, API has no migrate initContainer",
  { skip: helmAvailable ? false : "helm 3.16.3 unavailable" },
  () => {
    const { ok, output } = helmTemplate([
      "migrations.job.enabled=true",
      "postgres.enabled=false",
      "database.externalUrl=postgres://user:pw@db.example.com:5432/rakkr",
    ]);
    assert.ok(ok, `job-enabled external-DB install must render; got:\n${output}`);

    const job = renderedDoc(output, "Job", "component: migration");
    assert.ok(job, "the migration Job must render when migrations.job.enabled=true");
    assert.match(
      job,
      /helm\.sh\/hook.*pre-install,pre-upgrade/u,
      "Job must carry the pre-install/pre-upgrade hook",
    );
    assert.match(
      job,
      /helm\.sh\/hook-weight.*"-5"/u,
      "Job must carry hook-weight -5 to sequence before the API",
    );
    assert.match(
      job,
      /helm\.sh\/hook-delete-policy.*before-hook-creation/u,
      "Job must carry hook-delete-policy before-hook-creation",
    );
    assert.match(
      job,
      /- name:\s*wait-for-database/u,
      "Job must include the wait-for-database initContainer",
    );
    assert.match(job, /- name:\s*migrate/u, "Job must include the migrate container");

    const apiDeployment = renderedDoc(output, "Deployment", "component: api");
    assert.ok(apiDeployment, "the API Deployment must render");
    const initSection = /initContainers:[\s\S]*?\n {6}containers:/u.exec(apiDeployment);
    assert.ok(initSection, "API Deployment must define an initContainers section");
    assert.doesNotMatch(
      initSection[0],
      /- name:\s*migrate/u,
      "enabling the migration Job must disable the API's init-container migrate (no double-migrate)",
    );
    assert.match(
      initSection[0],
      /- name:\s*wait-for-database/u,
      "the API still waits for the database before starting",
    );
  },
);

test(
  "job enabled + bundled Postgres FAILS render (migration-job-requires-external guard)",
  { skip: helmAvailable ? false : "helm 3.16.3 unavailable" },
  () => {
    const { ok, output } = helmTemplate(["migrations.job.enabled=true"]);
    assert.equal(ok, false, `job + bundled Postgres must fail render; got:\n${output}`);
    assert.match(
      output,
      /requires postgres\.enabled=false/iu,
      "the render failure must explain the Job requires an external DB (postgres.enabled=false)",
    );
  },
);

test(
  "default (job disabled, bundled Postgres): API init-container migrate still renders",
  { skip: helmAvailable ? false : "helm 3.16.3 unavailable" },
  () => {
    const { ok, output } = helmTemplate([]);
    assert.ok(ok, `default install must render; got:\n${output}`);

    assert.equal(
      renderedDoc(output, "Job", "component: migration"),
      null,
      "no migration Job renders when migrations.job.enabled=false",
    );

    const apiDeployment = renderedDoc(output, "Deployment", "component: api");
    assert.ok(apiDeployment, "the API Deployment must render");
    const initSection = /initContainers:[\s\S]*?\n {6}containers:/u.exec(apiDeployment);
    assert.ok(initSection, "API Deployment must define an initContainers section");
    assert.match(
      initSection[0],
      /- name:\s*migrate/u,
      "the default path runs migrations via the API init-container migrate",
    );
  },
);
