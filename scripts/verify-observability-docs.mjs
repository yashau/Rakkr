import { access, readFile } from "node:fs/promises";

const runbookFile = "docs/observability/README.md";
const miseFile = ".mise.toml";
const requiredArtifacts = [
  "docs/observability/rakkr-alerts.yml",
  "docs/observability/prometheus-mimir.example.yml",
  "docs/observability/grafana-dashboard.example.json",
];
const requiredTasks = [
  "ops:check-alerts",
  "ops:check-prometheus",
  "ops:check-grafana",
  "ops:check-observability-docs",
];
const errors = [];

const [runbook, miseConfig] = await Promise.all([
  readFile(runbookFile, "utf8"),
  readFile(miseFile, "utf8"),
]);

for (const artifact of requiredArtifacts) {
  try {
    await access(artifact);
  } catch {
    errors.push(`missing observability artifact ${artifact}`);
  }

  if (!runbook.includes(artifact)) {
    errors.push(`${runbookFile} must reference ${artifact}`);
  }
}

for (const task of requiredTasks) {
  if (!runbook.includes(`mise run ${task}`)) {
    errors.push(`${runbookFile} must reference mise run ${task}`);
  }

  if (!miseConfig.includes(`[tasks."${task}"]`)) {
    errors.push(`${miseFile} must define task ${task}`);
  }
}

if (!runbook.includes("GET /metrics")) {
  errors.push(`${runbookFile} must mention the controller metrics endpoint`);
}

if (!runbook.includes("Rotating JSONL health log") || !runbook.includes("SQLite health-event store")) {
  errors.push(`${runbookFile} must mention the recorder node local health log`);
}

if (errors.length > 0) {
  console.error(`Invalid observability runbook in ${runbookFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified observability runbook links in ${runbookFile}.`);
