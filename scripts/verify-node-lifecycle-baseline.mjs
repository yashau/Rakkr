import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/internal/baselines/NODE_LIFECYCLE_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/agent-version.ts",
  "packages/shared/src/index.ts",
  "packages/shared/src/nodes.ts",
  "apps/api/src/node-lifecycle.ts",
  "apps/api/src/node-lifecycle-routes.ts",
  "apps/api/src/node-liveness.ts",
  "apps/api/src/watchdog-node-liveness.ts",
  "apps/api/src/agent-release-service.ts",
  "apps/api/src/agent-release-routes.ts",
  "apps/api/src/node-routes.ts",
  "apps/api/test/node-lifecycle.test.ts",
  "apps/api/test/node-lifecycle-routes.test.ts",
  "apps/api/test/node-liveness.test.ts",
  "apps/api/test/watchdog-runner.test.ts",
  "apps/api/test/agent-release-service.test.ts",
  "apps/api/test/agent-release-routes.test.ts",
  "apps/api/test/agent-version.test.ts",
  "apps/web/src/lib/node-lifecycle-api.ts",
  "apps/web/src/components/node-lifecycle-menu.tsx",
  "apps/web/src/pages/nodes.tsx",
  "crates/recorder-agent/src/version.rs",
  "crates/recorder-agent/src/inventory.rs",
  "deploy/ansible/runner.py",
  "deploy/ansible/playbooks/node-lifecycle.yml",
  "deploy/ansible/roles/recorder_node/tasks/update_binary.yml",
  "deploy/ansible/roles/recorder_node/defaults/main.yml",
];
const baselinePhrases = [
  "install_dependencies",
  "update_binary",
  "restart_service",
  "rotate_trust",
  "smoke_check",
  "node:manage",
  "node:read",
  "GET /api/v1/nodes/agent-release",
  "update available",
  "agentVersion",
  "agent-v",
  "0.0.0-dev",
  "stale-while-revalidate",
  "non-blocking",
  "runner run ID",
  "serial",
  "sha256",
  "never SSHes",
  "provisioning",
  "Awaiting first contact",
  "node_never_provisioned",
  "isNodeReachable",
  "rakkr_node_online",
  "mise run nodes:check-lifecycle",
];
const sourceSnippets = [
  "nodeLifecycleActions",
  '"install_dependencies"',
  '"update_binary"',
  '"restart_service"',
  '"rotate_trust"',
  '"smoke_check"',
  '"node:manage"',
  "nodes.lifecycle.",
  "scopedNodes",
  "resolveLatestAgentRelease",
  "application/vnd.github+json",
  "/releases?per_page=100",
  "/api/v1/nodes/agent-release",
  '"node:read"',
  '"nodes.agent_release.read"',
  "isAgentUpdateAvailable",
  "compareAgentVersions",
  "AGENT_RELEASE_TAG_PREFIX",
  '"0.0.0-dev"',
  "RAKKR_AGENT_VERSION",
  "agent_version",
  'rename_all = "camelCase"',
  "rakkr_agent_version",
  "releases/latest",
  "sha256",
  "recorder_node",
  "Update to ",
  "api.agentRelease",
  "Update available",
  "agentReleaseQuery",
  'if (node.status === "provisioning")',
  "node_never_provisioned",
  "reconcileNodeLivenessEvents",
  "nodeHeartbeatStale",
  "isNodeReachable",
];
const testSnippets = [
  "node lifecycle route runs allowlisted Ansible action and audits result",
  "node lifecycle route only targets scoped visible nodes",
  "node lifecycle HTTP runner does not override target SSH user by default",
  "resolveLatestAgentRelease picks the newest agent-v tag and ignores others",
  "stale-while-revalidate serves the old value then refreshes",
  "a failed refresh keeps the last good value and backs off",
  "agent-release route returns the cached snapshot and is gated by node:read",
  "isAgentUpdateAvailable only fires for a strictly newer real version",
  "compareAgentVersions orders by date then counter",
  "never-provisioned nodes are skipped by the liveness watchdog",
  "provisioning nodes never derive offline, however old their enrollment",
  "stale nodes derive offline status",
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
    errors.push(`missing node lifecycle evidence file ${sourceFile}`);
  }
}

for (const phrase of baselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of sourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`node lifecycle source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`node lifecycle tests must include "${snippet}"`);
  }
}

if (errors.length > 0) {
  console.error(`Invalid node lifecycle baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified node lifecycle baseline in ${baselineFile}.`);
