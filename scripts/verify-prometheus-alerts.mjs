import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const alertFile = "docs/observability/rakkr-alerts.yml";
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
const allowedFunctions = new Set(["increase", "sum"]);

const document = parse(await readFile(alertFile, "utf8"));
const errors = [];
const alertNames = new Set();

if (!document || !Array.isArray(document.groups)) {
  errors.push("alert file must contain a top-level groups array");
} else {
  for (const [groupIndex, group] of document.groups.entries()) {
    const groupName = stringValue(group?.name);

    if (!groupName) {
      errors.push(`groups[${groupIndex}] must have a name`);
    }

    if (!Array.isArray(group?.rules) || group.rules.length === 0) {
      errors.push(`${groupName || `groups[${groupIndex}]`} must have rules`);
      continue;
    }

    for (const [ruleIndex, rule] of group.rules.entries()) {
      const location = `${groupName || `groups[${groupIndex}]`}.rules[${ruleIndex}]`;
      const alert = stringValue(rule?.alert);
      const expr = stringValue(rule?.expr);

      if (!alert) {
        errors.push(`${location} must have an alert name`);
      } else if (alertNames.has(alert)) {
        errors.push(`${location} duplicates alert ${alert}`);
      } else {
        alertNames.add(alert);
      }

      if (!expr) {
        errors.push(`${location} must have an expr`);
      } else {
        for (const token of rakkrTokens(expr)) {
          if (!knownMetrics.has(token)) {
            errors.push(`${location} references unknown metric ${token}`);
          }
        }

        for (const fn of promqlFunctionTokens(expr)) {
          if (!allowedFunctions.has(fn)) {
            errors.push(`${location} uses unreviewed PromQL function ${fn}`);
          }
        }
      }

      if (!durationValue(rule?.for)) {
        errors.push(`${location} must have a Prometheus duration in for`);
      }

      if (!["critical", "warning"].includes(rule?.labels?.severity)) {
        errors.push(`${location} must label severity as warning or critical`);
      }

      if (!stringValue(rule?.labels?.component)) {
        errors.push(`${location} must label component`);
      }

      if (!stringValue(rule?.annotations?.summary)) {
        errors.push(`${location} must have an annotation summary`);
      }

      if (!stringValue(rule?.annotations?.description)) {
        errors.push(`${location} must have an annotation description`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Invalid Prometheus alert rules in ${alertFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified ${alertNames.size} Prometheus alert rules in ${alertFile}.`);

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function durationValue(value) {
  const text = stringValue(value);
  return text && /^\d+[smhdwy]$/.test(text) ? text : undefined;
}

function rakkrTokens(expr) {
  return expr.match(/\brakkr_[a-zA-Z0-9_:]+\b/g) ?? [];
}

function promqlFunctionTokens(expr) {
  return Array.from(expr.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g), (match) => match[1]);
}
