import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const configFile = "docs/observability/prometheus-mimir.example.yml";
const configDirectory = path.dirname(configFile);
const config = parse(await readFile(configFile, "utf8"));
const errors = [];

if (!config || typeof config !== "object") {
  errors.push("config must parse as a YAML object");
} else {
  validateGlobal(config.global);
  await validateRuleFiles(config.rule_files);
  validateScrapes(config.scrape_configs);
  validateRemoteWrite(config.remote_write);
}

if (errors.length > 0) {
  console.error(`Invalid Prometheus config in ${configFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified Prometheus scrape and Mimir remote_write config in ${configFile}.`);

function validateGlobal(globalConfig) {
  if (!globalConfig || typeof globalConfig !== "object") {
    errors.push("global config is required");
    return;
  }

  if (!durationValue(globalConfig.scrape_interval)) {
    errors.push("global.scrape_interval must be a Prometheus duration");
  }

  if (!durationValue(globalConfig.evaluation_interval)) {
    errors.push("global.evaluation_interval must be a Prometheus duration");
  }

  if (!stringValue(globalConfig.external_labels?.cluster)) {
    errors.push("global.external_labels.cluster is required");
  }
}

async function validateRuleFiles(ruleFiles) {
  if (!Array.isArray(ruleFiles) || ruleFiles.length === 0) {
    errors.push("rule_files must include at least one file");
    return;
  }

  if (!ruleFiles.includes("rakkr-alerts.yml")) {
    errors.push('rule_files must include "rakkr-alerts.yml"');
  }

  for (const ruleFile of ruleFiles) {
    if (!stringValue(ruleFile)) {
      errors.push("rule_files entries must be non-empty strings");
      continue;
    }

    try {
      await access(path.join(configDirectory, ruleFile));
    } catch {
      errors.push(`rule file does not exist: ${ruleFile}`);
    }
  }
}

function validateScrapes(scrapeConfigs) {
  if (!Array.isArray(scrapeConfigs)) {
    errors.push("scrape_configs must be an array");
    return;
  }

  const controller = scrapeConfigs.find((scrape) => scrape?.job_name === "rakkr-controller");

  if (!controller) {
    errors.push('scrape_configs must include job_name "rakkr-controller"');
    return;
  }

  if (controller.scheme !== "https") {
    errors.push("rakkr-controller scrape should use https");
  }

  if (controller.metrics_path !== "/metrics") {
    errors.push('rakkr-controller scrape must use metrics_path "/metrics"');
  }

  const targets = controller.static_configs?.flatMap((config) => config.targets ?? []) ?? [];

  if (!targets.includes("rakkr-controller:8787")) {
    errors.push('rakkr-controller scrape must target "rakkr-controller:8787"');
  }
}

function validateRemoteWrite(remoteWrites) {
  if (!Array.isArray(remoteWrites) || remoteWrites.length === 0) {
    errors.push("remote_write must include a Mimir target");
    return;
  }

  const mimir = remoteWrites.find((write) => write?.name === "rakkr-mimir");

  if (!mimir) {
    errors.push('remote_write must include name "rakkr-mimir"');
    return;
  }

  if (!/^https:\/\/.+\/api\/v1\/push$/.test(stringValue(mimir.url) ?? "")) {
    errors.push("rakkr-mimir remote_write.url must be an HTTPS /api/v1/push endpoint");
  }

  if (!stringValue(mimir.headers?.["X-Scope-OrgID"])) {
    errors.push("rakkr-mimir remote_write should set X-Scope-OrgID");
  }

  if (stringValue(mimir.basic_auth?.password)) {
    errors.push("rakkr-mimir remote_write must use password_file instead of inline password");
  }

  if (!stringValue(mimir.basic_auth?.password_file)) {
    errors.push("rakkr-mimir remote_write must set basic_auth.password_file");
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function durationValue(value) {
  const text = stringValue(value);
  return text && /^\d+[smhdwy]$/.test(text) ? text : undefined;
}
