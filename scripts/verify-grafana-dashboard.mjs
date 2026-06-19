import { readFile } from "node:fs/promises";

const dashboardFile = "docs/observability/grafana-dashboard.example.json";
const requiredMetrics = new Set([
  "rakkr_audit_events_total",
  "rakkr_device_xruns_total",
  "rakkr_input_rms_dbfs",
  "rakkr_node_online",
  "rakkr_recording_active",
  "rakkr_recording_watchdog_alerts_active",
  "rakkr_upload_queue_depth",
  "rakkr_upload_queue_oldest_due_seconds",
]);
const knownMetrics = new Set([
  "rakkr_audit_events_total",
  "rakkr_controller_started_at_seconds",
  "rakkr_device_xruns_active",
  "rakkr_device_xruns_total",
  "rakkr_health_events_active",
  "rakkr_health_events_total",
  "rakkr_input_clipping_ratio",
  "rakkr_input_noise_score",
  "rakkr_input_peak_dbfs",
  "rakkr_input_rms_dbfs",
  "rakkr_input_speech_score",
  "rakkr_node_offline_alerts_active",
  "rakkr_node_online",
  "rakkr_recording_active",
  "rakkr_recording_bytes_written",
  "rakkr_recording_cached",
  "rakkr_recording_duration_seconds",
  "rakkr_recording_jobs",
  "rakkr_recording_watchdog_alerts_active",
  "rakkr_recording_watchdog_alerts_total",
  "rakkr_upload_failures_total",
  "rakkr_upload_queue_depth",
  "rakkr_upload_queue_oldest_due_seconds",
]);
const allowedFunctions = new Set(["increase", "max", "sum"]);

const dashboard = JSON.parse(await readFile(dashboardFile, "utf8"));
const errors = [];
const panelIds = new Set();
const panelTitles = new Set();
const referencedMetrics = new Set();

if (dashboard.title !== "Rakkr Operations") {
  errors.push('dashboard title must be "Rakkr Operations"');
}

if (dashboard.uid !== "rakkr-operations") {
  errors.push('dashboard uid must be "rakkr-operations"');
}

if (dashboard.timezone !== "browser") {
  errors.push('dashboard timezone must be "browser"');
}

if (!Array.isArray(dashboard.tags) || !dashboard.tags.includes("rakkr")) {
  errors.push('dashboard tags must include "rakkr"');
}

if (!Array.isArray(dashboard.panels) || dashboard.panels.length === 0) {
  errors.push("dashboard must contain panels");
} else {
  for (const [index, panel] of dashboard.panels.entries()) {
    validatePanel(panel, index);
  }
}

for (const metric of requiredMetrics) {
  if (!referencedMetrics.has(metric)) {
    errors.push(`dashboard must reference required metric ${metric}`);
  }
}

if (errors.length > 0) {
  console.error(`Invalid Grafana dashboard in ${dashboardFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified ${dashboard.panels.length} Grafana dashboard panels in ${dashboardFile}.`);

function validatePanel(panel, index) {
  const location = `panels[${index}]`;

  if (!Number.isInteger(panel?.id) || panel.id <= 0) {
    errors.push(`${location} must have a positive integer id`);
  } else if (panelIds.has(panel.id)) {
    errors.push(`${location} duplicates panel id ${panel.id}`);
  } else {
    panelIds.add(panel.id);
  }

  if (!stringValue(panel?.title)) {
    errors.push(`${location} must have a title`);
  } else if (panelTitles.has(panel.title)) {
    errors.push(`${location} duplicates panel title ${panel.title}`);
  } else {
    panelTitles.add(panel.title);
  }

  if (!["stat", "timeseries"].includes(panel?.type)) {
    errors.push(`${location} type must be stat or timeseries`);
  }

  if (panel?.datasource?.type !== "prometheus") {
    errors.push(`${location} datasource.type must be prometheus`);
  }

  if (!validGrid(panel?.gridPos)) {
    errors.push(`${location} must have a valid gridPos`);
  }

  if (!Array.isArray(panel?.targets) || panel.targets.length === 0) {
    errors.push(`${location} must have at least one target`);
    return;
  }

  for (const [targetIndex, target] of panel.targets.entries()) {
    validateTarget(target, `${location}.targets[${targetIndex}]`);
  }
}

function validateTarget(target, location) {
  const expr = stringValue(target?.expr);

  if (!stringValue(target?.refId)) {
    errors.push(`${location} must have refId`);
  }

  if (target?.datasource?.type !== "prometheus") {
    errors.push(`${location} datasource.type must be prometheus`);
  }

  if (!expr) {
    errors.push(`${location} must have expr`);
    return;
  }

  for (const metric of rakkrTokens(expr)) {
    referencedMetrics.add(metric);

    if (!knownMetrics.has(metric)) {
      errors.push(`${location} references unknown metric ${metric}`);
    }
  }

  for (const fn of promqlFunctionTokens(expr)) {
    if (!allowedFunctions.has(fn)) {
      errors.push(`${location} uses unreviewed PromQL function ${fn}`);
    }
  }
}

function validGrid(grid) {
  return (
    Number.isInteger(grid?.h) &&
    Number.isInteger(grid?.w) &&
    Number.isInteger(grid?.x) &&
    Number.isInteger(grid?.y) &&
    grid.h > 0 &&
    grid.w > 0 &&
    grid.x >= 0 &&
    grid.y >= 0
  );
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function rakkrTokens(expr) {
  return expr.match(/\brakkr_[a-zA-Z0-9_:]+\b/g) ?? [];
}

function promqlFunctionTokens(expr) {
  return Array.from(expr.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g), (match) => match[1])
    .filter((token) => token !== "by" && token !== "without");
}
