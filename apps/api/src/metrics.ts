import type {
  HealthEvent,
  MeterFrame,
  RecorderNode,
  RecordingJob,
  RecordingSummary,
  UploadQueueItem,
} from "@rakkr/shared";

import { nodeOfflineEventType, scheduledLowSignalEventType } from "./watchdog-runner.js";

export interface PrometheusMetricsInput {
  healthEvents: HealthEvent[];
  meterFrames: MeterFrame[];
  nodes: RecorderNode[];
  recordingJobs: RecordingJob[];
  recordings: RecordingSummary[];
  startedAt: Date;
  uploadQueueItems: UploadQueueItem[];
}

type MetricLabels = Record<string, boolean | number | string | undefined>;

export function renderPrometheusMetrics(input: PrometheusMetricsInput) {
  const lines: string[] = [];

  pushHelp(lines, "rakkr_controller_started_at_seconds", "Controller process start timestamp.");
  pushType(lines, "rakkr_controller_started_at_seconds", "gauge");
  pushMetric(lines, "rakkr_controller_started_at_seconds", {}, input.startedAt.getTime() / 1000);

  pushHelp(lines, "rakkr_node_online", "Whether a recorder node is reachable.");
  pushType(lines, "rakkr_node_online", "gauge");
  for (const node of input.nodes) {
    pushMetric(lines, "rakkr_node_online", nodeLabels(node), node.status === "offline" ? 0 : 1);
  }

  pushHelp(lines, "rakkr_recording_active", "Active recording jobs by recorder node.");
  pushType(lines, "rakkr_recording_active", "gauge");
  for (const node of input.nodes) {
    pushMetric(
      lines,
      "rakkr_recording_active",
      { node_id: node.id },
      activeRecordings(node, input),
    );
  }

  pushHelp(lines, "rakkr_recording_cached", "Cached recordings by recorder node.");
  pushType(lines, "rakkr_recording_cached", "gauge");
  for (const node of input.nodes) {
    pushMetric(
      lines,
      "rakkr_recording_cached",
      { node_id: node.id },
      cachedRecordings(node, input),
    );
  }

  pushHelp(lines, "rakkr_recording_jobs", "Recording jobs by recorder node and status.");
  pushType(lines, "rakkr_recording_jobs", "gauge");
  for (const node of input.nodes) {
    for (const status of [
      "queued",
      "running",
      "stop_requested",
      "cancelled",
      "completed",
      "failed",
    ]) {
      pushMetric(
        lines,
        "rakkr_recording_jobs",
        { node_id: node.id, status },
        input.recordingJobs.filter((job) => job.nodeId === node.id && job.status === status).length,
      );
    }
  }

  pushHelp(lines, "rakkr_input_rms_dbfs", "Latest RMS input level by audio channel.");
  pushType(lines, "rakkr_input_rms_dbfs", "gauge");
  pushHelp(lines, "rakkr_input_peak_dbfs", "Latest peak input level by audio channel.");
  pushType(lines, "rakkr_input_peak_dbfs", "gauge");
  pushHelp(lines, "rakkr_input_clipping_ratio", "Latest clipping state by audio channel.");
  pushType(lines, "rakkr_input_clipping_ratio", "gauge");
  pushHelp(lines, "rakkr_input_speech_score", "Latest local speech-likelihood score by channel.");
  pushType(lines, "rakkr_input_speech_score", "gauge");
  pushHelp(lines, "rakkr_input_noise_score", "Latest local non-speech noise score by channel.");
  pushType(lines, "rakkr_input_noise_score", "gauge");
  for (const frame of input.meterFrames) {
    for (const level of frame.levels) {
      const labels = {
        channel: level.channelIndex,
        interface_id: frame.interfaceId,
        node_id: frame.nodeId,
      };

      pushMetric(lines, "rakkr_input_rms_dbfs", labels, level.rmsDbfs);
      pushMetric(lines, "rakkr_input_peak_dbfs", labels, level.peakDbfs);
      pushMetric(lines, "rakkr_input_clipping_ratio", labels, level.clipping ? 1 : 0);

      if (level.quality) {
        pushMetric(lines, "rakkr_input_speech_score", labels, level.quality.speechScore);
        pushMetric(lines, "rakkr_input_noise_score", labels, level.quality.noiseScore);
      }
    }
  }

  pushHelp(lines, "rakkr_health_events_active", "Unresolved health events by severity and status.");
  pushType(lines, "rakkr_health_events_active", "gauge");
  for (const severity of ["info", "warning", "critical"]) {
    for (const status of ["open", "acknowledged", "suppressed"]) {
      pushMetric(
        lines,
        "rakkr_health_events_active",
        { severity, status },
        input.healthEvents.filter((event) => event.severity === severity && event.status === status)
          .length,
      );
    }
  }

  pushHelp(lines, "rakkr_recording_watchdog_alerts_active", "Unresolved watchdog health events.");
  pushType(lines, "rakkr_recording_watchdog_alerts_active", "gauge");
  for (const severity of ["warning", "critical"]) {
    pushMetric(
      lines,
      "rakkr_recording_watchdog_alerts_active",
      { severity },
      input.healthEvents.filter(
        (event) =>
          event.type === scheduledLowSignalEventType &&
          event.severity === severity &&
          event.status !== "resolved",
      ).length,
    );
  }

  pushHelp(lines, "rakkr_node_offline_alerts_active", "Unresolved node-offline health events.");
  pushType(lines, "rakkr_node_offline_alerts_active", "gauge");
  for (const node of input.nodes) {
    for (const severity of ["warning", "critical"]) {
      for (const status of ["open", "acknowledged", "suppressed"]) {
        pushMetric(
          lines,
          "rakkr_node_offline_alerts_active",
          { node_id: node.id, severity, status },
          input.healthEvents.filter(
            (event) =>
              event.nodeId === node.id &&
              event.type === nodeOfflineEventType &&
              event.severity === severity &&
              event.status === status,
          ).length,
        );
      }
    }
  }

  pushHelp(lines, "rakkr_device_xruns_active", "Unresolved audio xrun health events.");
  pushType(lines, "rakkr_device_xruns_active", "gauge");
  pushMetric(
    lines,
    "rakkr_device_xruns_active",
    {},
    input.healthEvents.filter((event) => event.type.includes("xrun") && event.status !== "resolved")
      .length,
  );

  pushHelp(lines, "rakkr_upload_queue_depth", "Upload queue items by provider and status.");
  pushType(lines, "rakkr_upload_queue_depth", "gauge");
  for (const provider of ["stub", "smb", "s3"]) {
    for (const status of ["queued", "retrying", "failed"]) {
      pushMetric(
        lines,
        "rakkr_upload_queue_depth",
        { provider, status },
        input.uploadQueueItems.filter(
          (item) => item.provider === provider && item.status === status,
        ).length,
      );
    }
  }

  pushHelp(lines, "rakkr_upload_failures_total", "Failed upload queue attempts.");
  pushType(lines, "rakkr_upload_failures_total", "counter");
  for (const provider of ["stub", "smb", "s3"]) {
    pushMetric(
      lines,
      "rakkr_upload_failures_total",
      { provider },
      input.uploadQueueItems
        .filter((item) => item.provider === provider && item.status === "failed")
        .reduce((total, item) => total + Math.max(1, item.attemptCount), 0),
    );
  }

  return `${lines.join("\n")}\n`;
}

function activeRecordings(node: RecorderNode, input: PrometheusMetricsInput) {
  const activeIds = new Set(
    input.recordings
      .filter((recording) => recording.nodeId === node.id && recording.status === "recording")
      .map((recording) => recording.id),
  );

  for (const job of input.recordingJobs) {
    if (job.nodeId === node.id && (job.status === "running" || job.status === "stop_requested")) {
      activeIds.add(job.recordingId);
    }
  }

  return activeIds.size;
}

function cachedRecordings(node: RecorderNode, input: PrometheusMetricsInput) {
  return input.recordings.filter((recording) => recording.nodeId === node.id && recording.cached)
    .length;
}

function nodeLabels(node: RecorderNode): MetricLabels {
  return {
    alias: node.alias,
    node_id: node.id,
    room: node.location.room,
    site: node.location.site,
    status: node.status,
  };
}

function pushHelp(lines: string[], name: string, description: string) {
  lines.push(`# HELP ${name} ${description}`);
}

function pushType(lines: string[], name: string, type: "counter" | "gauge") {
  lines.push(`# TYPE ${name} ${type}`);
}

function pushMetric(lines: string[], name: string, labels: MetricLabels, value: number) {
  const labelEntries = Object.entries(labels).filter(
    (entry): entry is [string, boolean | number | string] => entry[1] !== undefined,
  );
  const labelText =
    labelEntries.length > 0
      ? `{${labelEntries.map(([key, label]) => `${key}="${escapeLabel(label)}"`).join(",")}}`
      : "";

  lines.push(`${name}${labelText} ${metricValue(value)}`);
}

function escapeLabel(value: boolean | number | string) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function metricValue(value: number) {
  return Number.isFinite(value) ? String(value) : "NaN";
}
