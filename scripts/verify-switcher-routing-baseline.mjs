import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/internal/baselines/SWITCHER_ROUTING_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/switchers.ts",
  "packages/shared/src/index.ts",
  "packages/db/src/schema.ts",
  "packages/db/drizzle/0039_same_nicolaos.sql",
  "apps/api/src/switchers/transport.ts",
  "apps/api/src/switchers/driver.ts",
  "apps/api/src/switchers/avpro-ac-max.ts",
  "apps/api/src/switcher-store.ts",
  "apps/api/src/switcher-mapping-store.ts",
  "apps/api/src/switcher-routes.ts",
  "apps/api/src/switcher-mapping-routes.ts",
  "apps/api/src/switcher-routing-runner.ts",
  "apps/api/src/api-runners.ts",
  "apps/api/test/switcher-driver.test.ts",
  "apps/api/test/switcher-store.test.ts",
  "apps/api/test/switcher-route-permissions.test.ts",
  "apps/api/test/switcher-mapping-routes.test.ts",
  "apps/api/test/switcher-routing-runner.test.ts",
  "apps/web/src/lib/switcher-page-helpers.ts",
  "apps/web/src/lib/switcher-page-helpers.test.ts",
  "apps/web/src/components/settings-switchers-section.tsx",
];
const baselinePhrases = [
  "AVPro Edge AC-MAX",
  "SET OUTx AS INy",
  "GET CONFIG",
  "secret-box",
  "observe",
  "enforce",
  "Owned outputs only",
  "Leave-as-is when idle",
  "live meeting only",
  "switcher.unreachable",
  "system:switcher-router",
  "switcher:read",
  "switcher:manage",
  "switcher:map",
  "mise run switcher:check",
];
const sourceSnippets = [
  "SET OUT",
  "GET OUT0 AS",
  "GET IN0 SIG STA",
  "computeDesiredRoutes",
  "scheduleActiveAt",
  "diffRoutes",
  "switchers.reconcile.succeeded",
  "switchers.reconcile.observed",
  "switchers.reconcile.failed",
  "switcher.unreachable",
  "system:switcher-router",
  "settings.switchers.create.succeeded",
  "settings.switchers.mappings.update.succeeded",
  "encryptSecret",
  "switcher_input_map",
  "switcher_output_map",
  '"switcher:read"',
  '"switcher:manage"',
  '"switcher:map"',
  '"avpro-ac-max"',
];
const testSnippets = [
  "live AC-MAX round-trips a route on a spare output",
  "enforce mode applies owned-output changes and leaves idle outputs untouched",
  "observe mode plans but never writes",
  "opens an unreachable health event once and resolves it on recovery",
  "rejects out-of-range channels, duplicates, and unknown references",
  "switcher routes deny users without the required permission",
  "persists switcher config, redacts secrets, and resolves decrypted connection",
];
const errors = [];

const baseline = await readFile(baselineFile, "utf8");
const sourceEntries = await Promise.all(
  sourceFiles.map(async (sourceFile) => ({
    content: await readFile(sourceFile, "utf8"),
    path: sourceFile,
  })),
);
const allSource = sourceEntries.map((entry) => entry.content).join("\n");
const allTests = sourceEntries
  .filter((entry) => entry.path.endsWith(".test.ts"))
  .map((entry) => entry.content)
  .join("\n");

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing switcher evidence file ${sourceFile}`);
  }
}

for (const phrase of baselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of sourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`switcher source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`switcher tests must include "${snippet}"`);
  }
}

if (errors.length > 0) {
  console.error(`Invalid switcher routing baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified switcher routing baseline in ${baselineFile}.`);
