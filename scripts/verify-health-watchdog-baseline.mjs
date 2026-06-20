import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/health/HEALTH_WATCHDOG_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/index.ts",
  "apps/api/src/watchdog-clipping.ts",
  "apps/api/src/watchdog-runner.ts",
  "apps/api/src/watchdog-signal.ts",
  "apps/api/src/watchdog-calibration.ts",
  "apps/api/src/watchdog-calibration-routes.ts",
  "apps/api/src/watchdog-node-liveness.ts",
  "apps/api/src/health-store.ts",
  "apps/api/src/health-routes.ts",
  "apps/api/src/health-sync.ts",
  "apps/api/src/metrics.ts",
  "apps/web/src/components/meter-bank.tsx",
  "apps/web/src/components/quality-timeline.tsx",
  "apps/web/src/lib/settings-page-helpers.ts",
  "apps/web/src/lib/meter-helpers.ts",
  "apps/web/src/lib/quality-timeline-helpers.ts",
  "crates/recorder-agent/src/main.rs",
  "crates/recorder-agent/src/system_health.rs",
  "crates/recorder-agent/src/health_log.rs",
  "crates/recorder-agent/src/telemetry.rs",
  "crates/recorder-agent/src/capture.rs",
  "crates/recorder-agent/src/controller.rs",
  "scripts/agent-fake-controller-smoke.mjs",
  "apps/api/test/watchdog-runner.test.ts",
  "apps/api/test/watchdog-calibration-routes.test.ts",
  "apps/api/test/health-routes.test.ts",
  "apps/api/test/health-store.test.ts",
  "apps/api/test/metrics.test.ts",
  "apps/web/src/lib/settings-page-helpers.test.ts",
  "apps/web/src/lib/meter-helpers.test.ts",
  "apps/web/src/lib/quality-timeline-helpers.test.ts",
];
const baselinePhrases = [
  "Partial baseline checked",
  "configurable grace, window, metric, dBFS threshold",
  "open, repeat, and auto-resolve",
  "Speech-required policies",
  "Channel-correlation policies",
  "Clipping policies",
  "hum/static",
  "Node liveness",
  "local JSONL health logs",
  "meter capture failure/recovery",
  "device unavailable/xrun",
  "clipping",
  "flatline",
  "channel correlation",
  "capture growth failure",
  "cache upload failure",
  "RBAC-gated",
  "resource-scoped",
  "quality timelines",
  "event-specific evidence",
  "Prometheus export",
  "synthetic PCM calibration fixtures",
  "field calibration",
  "RBAC-mirrored watchdog calibration controls",
  "hum/static likelihood",
  "long-duration real-room validation",
  "mise run health:check-watchdog",
];
const sourceSnippets = [
  "scheduledLowSignalEventType",
  "nodeOfflineEventType",
  "createWatchdogRunner",
  "health.watchdog.low_signal.created",
  "health.watchdog.low_signal.repeated",
  "health.watchdog.low_signal.resolved",
  "health.watchdog.node_offline.created",
  "health.watchdog.node_offline.resolved",
  "health.watchdog.channel_correlation.created",
  "health.watchdog.channel_correlation.repeated",
  "health.watchdog.channel_correlation.resolved",
  "health.watchdog.clipping.created",
  "health.watchdog.clipping.repeated",
  "health.watchdog.clipping.resolved",
  "settings.watchdog_policies.calibrate.succeeded",
  "calibrateWatchdogPolicy",
  "insufficient_meter_history",
  "signalBelowThreshold",
  "speechBelowThreshold",
  "channelCorrelationAboveThreshold",
  "channelCorrelationIsAbovePolicy",
  "channelCorrelationMode",
  "channelCorrelationThreshold",
  "minCumulativeChannelCorrelationSeconds",
  "clippingEventType",
  "clippingIsAbovePolicy",
  "cumulativeClippingSeconds",
  "minCumulativeClippingSeconds",
  "maxNoiseScore",
  "minCumulativeSpeechSeconds",
  "syncRecordingHealth",
  "visibleHealthEvent",
  "updateHealthLifecycle",
  "rakkr_recording_watchdog_alerts_active",
  "rakkr_node_offline_alerts_active",
  "rakkr_device_xruns_total",
  "rakkr_input_clipping_ratio",
  "rakkr_input_speech_score",
  "rakkr_input_noise_score",
  "rakkr_input_hum_score",
  "rakkr_input_static_score",
  "rakkr_input_channel_correlation_score",
  "MeterBank",
  "QualityTimeline",
  "watchdogCalibrationActionState",
  "qualityEventEvidenceText",
  "speechLabel",
  "agent.meter.clipping",
  "agent.meter.flatline",
  "agent.meter.channel_correlation",
  "agent.meter.xrun",
  "agent.system.disk_pressure",
  "agent.audio_backend.unavailable",
  "append_health_event_with_targets",
  "rotate_if_needed",
  "capture output stalled",
  "agent.recording_job.capture_output_stalled",
  "cache upload local health event",
  "speech_score",
  "noise_score",
  "hum_score",
  "static_score",
  "channelCorrelation",
  "correlated_channel_pairs",
  "channel_correlation_pairs_deduplicate_peer_entries",
  "estimates_hum_and_static_likelihood_from_pcm_shape",
  "calibrates_voice_hum_static_and_silence_fixtures",
  "calibration_fixtures_keep_independent_channels_uncorrelated",
  "estimates_same_phase_and_inverted_channel_correlation",
];
const testSnippets = [
  "alerts when scheduled audio is loud but not speech-like",
  "creates and resolves scheduled channel correlation alerts from policy",
  "creates and resolves scheduled clipping alerts from policy",
  "watchdog calibration applies recommended field threshold",
  "watchdog calibration audits insufficient meter history",
  "watchdog calibration action requires settings manage node read and nodes",
  "repeats unresolved scheduled low-signal alerts after policy interval",
  "resolves scheduled low-signal alerts when signal recovers",
  "creates and resolves stale node heartbeat health events",
  "health routes deny users without required permissions",
  "health event store filters by event type",
  "rakkr_recording_watchdog_alerts_active",
  "rakkr_node_offline_alerts_active",
  "rakkr_device_xruns_total",
  "rakkr_input_hum_score",
  "rakkr_input_static_score",
  "rakkr_input_channel_correlation_score",
  "meter channel view exposes level voice and clipping state",
  "quality timeline evidence describes clipping channels and duration",
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
  .filter((entry) => entry.path.includes("/test/") || entry.path.endsWith(".test.ts"))
  .map((entry) => entry.content)
  .join("\n");

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing health watchdog evidence file ${sourceFile}`);
  }

  if (sourceFile.includes(".test.") && !baseline.includes(sourceFile)) {
    errors.push(`${baselineFile} should reference ${sourceFile}`);
  }
}

for (const phrase of baselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of sourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`health watchdog source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`health watchdog tests must include "${snippet}"`);
  }
}

if (/Status:\s*MVP baseline checked/iu.test(baseline)) {
  errors.push(`${baselineFile} must remain partial until long-duration real-room validation closes`);
}

if (errors.length > 0) {
  console.error(`Invalid health watchdog baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified health watchdog partial baseline in ${baselineFile}.`);
