import assert from "node:assert/strict";
import test from "node:test";
import type {
  HealthEvent,
  MeterFrame,
  RecorderNode,
  RecordingJob,
  RecordingSummary,
  UploadQueueItem,
} from "@rakkr/shared";

import { renderPrometheusMetrics } from "../src/metrics.js";

test("renders store-backed Prometheus gauges", () => {
  const output = renderPrometheusMetrics({
    healthEvents: [healthEvent(), nodeOfflineHealthEvent(), audioXrunHealthEvent()],
    meterFrames: [meterFrame()],
    nodes: [node()],
    observedAt: new Date("2026-06-18T12:16:00.000Z"),
    recordingCacheBytes: {
      rec_demo_001: 4096,
    },
    recordingJobs: [recordingJob()],
    recordings: [recording()],
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
    uploadQueueItems: [
      uploadQueueItem(),
      uploadQueueItem({
        attemptCount: 0,
        id: "upload_due_s3",
        nextAttemptAt: "2026-06-18T12:14:30.000Z",
        provider: "s3",
        status: "queued",
      }),
      uploadQueueItem({
        attemptCount: 1,
        id: "upload_future_s3",
        nextAttemptAt: "2026-06-18T12:20:00.000Z",
        provider: "s3",
        status: "retrying",
      }),
    ],
  });

  assert.match(output, /rakkr_controller_started_at_seconds 1781784000/);
  assert.match(
    output,
    /rakkr_node_online\{alias="Council Chamber \\"Rack\\"",node_id="node_x32_test",room="Council Chamber",site="Main Office",status="recording"\} 1/,
  );
  assert.match(output, /rakkr_recording_active\{node_id="node_x32_test"\} 1/);
  assert.match(output, /rakkr_recording_cached\{node_id="node_x32_test"\} 1/);
  assert.match(
    output,
    /rakkr_recording_duration_seconds\{node_id="node_x32_test",recording_id="rec_demo_001",source="schedule",status="recording"\} 300/,
  );
  assert.match(
    output,
    /rakkr_recording_bytes_written\{node_id="node_x32_test",recording_id="rec_demo_001",source="schedule",status="recording"\} 4096/,
  );
  assert.match(output, /rakkr_recording_jobs\{node_id="node_x32_test",status="running"\} 1/);
  assert.match(
    output,
    /rakkr_input_rms_dbfs\{channel="1",interface_id="iface_x32_usb",node_id="node_x32_test"\} -18.5/,
  );
  assert.match(
    output,
    /rakkr_input_clipping_ratio\{channel="1",interface_id="iface_x32_usb",node_id="node_x32_test"\} 1/,
  );
  assert.match(
    output,
    /rakkr_input_speech_score\{channel="1",interface_id="iface_x32_usb",node_id="node_x32_test"\} 0.82/,
  );
  assert.match(
    output,
    /rakkr_input_noise_score\{channel="1",interface_id="iface_x32_usb",node_id="node_x32_test"\} 0.12/,
  );
  assert.match(output, /rakkr_health_events_active\{severity="critical",status="open"\} 2/);
  assert.match(
    output,
    /rakkr_health_events_total\{event_type="audio\.alsa_xrun",severity="warning",status="resolved"\} 1/,
  );
  assert.match(
    output,
    /rakkr_health_events_total\{event_type="watchdog\.scheduled_low_signal",severity="critical",status="open"\} 1/,
  );
  assert.match(output, /rakkr_recording_watchdog_alerts_active\{severity="critical"\} 1/);
  assert.match(output, /rakkr_recording_watchdog_alerts_total\{severity="critical"\} 1/);
  assert.match(
    output,
    /rakkr_node_offline_alerts_active\{node_id="node_x32_test",severity="critical",status="open"\} 1/,
  );
  assert.match(output, /rakkr_device_xruns_total\{severity="warning"\} 1/);
  assert.match(output, /rakkr_upload_queue_depth\{provider="stub",status="failed"\} 1/);
  assert.match(output, /rakkr_upload_queue_oldest_due_seconds\{provider="s3",status="queued"\} 90/);
  assert.match(
    output,
    /rakkr_upload_queue_oldest_due_seconds\{provider="s3",status="retrying"\} 0/,
  );
  assert.match(output, /rakkr_upload_failures_total\{provider="stub"\} 3/);
});

function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: 'Council Chamber "Rack"',
    hostname: "zenith",
    id: "node_x32_test",
    interfaces: [],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Council Chamber",
      site: "Main Office",
    },
    status: "recording",
    tags: [],
  };
}

function recording(): RecordingSummary {
  return {
    cached: true,
    durationSeconds: 300,
    folder: "Meetings/2026",
    healthStatus: "critical",
    id: "rec_demo_001",
    name: "Council Meeting",
    nodeId: "node_x32_test",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "recording",
    tags: ["council"],
  };
}

function recordingJob(): RecordingJob {
  return {
    command: {
      captureChannels: 2,
      captureDevice: "hw:1,1,0",
      captureFormat: "S16_LE",
      captureSampleRate: 48_000,
      durationSeconds: 300,
      outputFileName: "rec_demo_001.wav",
      type: "alsa_capture",
    },
    createdAt: "2026-06-18T12:00:00.000Z",
    id: "job_demo_001",
    nodeId: "node_x32_test",
    recordingId: "rec_demo_001",
    status: "running",
  };
}

function meterFrame(): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:00:00.000Z",
    interfaceId: "iface_x32_usb",
    levels: [
      {
        channelIndex: 1,
        clipping: true,
        label: "Ch 1",
        peakDbfs: -2.1,
        quality: {
          crestFactorDb: 16.4,
          noiseScore: 0.12,
          speechLike: true,
          speechScore: 0.82,
          zeroCrossingRate: 0.09,
        },
        rmsDbfs: -18.5,
      },
    ],
    nodeId: "node_x32_test",
  };
}

function healthEvent(): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_demo_001",
    nodeId: "node_x32_test",
    openedAt: "2026-06-18T12:00:00.000Z",
    recordingId: "rec_demo_001",
    resolvedAt: null,
    severity: "critical",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.scheduled_low_signal",
  };
}

function nodeOfflineHealthEvent(): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_node_offline",
    nodeId: "node_x32_test",
    openedAt: "2026-06-18T12:05:00.000Z",
    resolvedAt: null,
    severity: "critical",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.node_offline",
  };
}

function audioXrunHealthEvent(): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_audio_xrun",
    nodeId: "node_x32_test",
    openedAt: "2026-06-18T12:10:00.000Z",
    resolvedAt: "2026-06-18T12:11:00.000Z",
    severity: "warning",
    status: "resolved",
    suppressedAt: null,
    suppressedUntil: null,
    type: "audio.alsa_xrun",
  };
}

function uploadQueueItem(input: Partial<UploadQueueItem> = {}): UploadQueueItem {
  return {
    attemptCount: 3,
    cachePath: "scheduled/rec_demo_001.wav",
    checksum: "sha256:demo",
    createdAt: "2026-06-18T12:00:00.000Z",
    fileName: "Council Meeting.wav",
    id: "upload_demo_001",
    lastError: "provider_not_configured",
    maxAttempts: 3,
    nextAttemptAt: "2026-06-18T12:15:00.000Z",
    provider: "stub",
    recordingId: "rec_demo_001",
    status: "failed",
    updatedAt: "2026-06-18T12:05:00.000Z",
    ...input,
  };
}
