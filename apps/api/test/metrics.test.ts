import assert from "node:assert/strict";
import test from "node:test";
import type {
  HealthEvent,
  MeterFrame,
  RecorderNode,
  RecordingJob,
  RecordingSummary,
} from "@rakkr/shared";

import { renderPrometheusMetrics } from "../src/metrics.js";

test("renders store-backed Prometheus gauges", () => {
  const output = renderPrometheusMetrics({
    healthEvents: [healthEvent()],
    meterFrames: [meterFrame()],
    nodes: [node()],
    recordingJobs: [recordingJob()],
    recordings: [recording()],
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  assert.match(output, /rakkr_controller_started_at_seconds 1781784000/);
  assert.match(
    output,
    /rakkr_node_online\{alias="Council Chamber \\"Rack\\"",node_id="node_x32_test",room="Council Chamber",site="Main Office",status="recording"\} 1/,
  );
  assert.match(output, /rakkr_recording_active\{node_id="node_x32_test"\} 1/);
  assert.match(output, /rakkr_recording_cached\{node_id="node_x32_test"\} 1/);
  assert.match(output, /rakkr_recording_jobs\{node_id="node_x32_test",status="running"\} 1/);
  assert.match(
    output,
    /rakkr_input_rms_dbfs\{channel="1",interface_id="iface_x32_usb",node_id="node_x32_test"\} -18.5/,
  );
  assert.match(
    output,
    /rakkr_input_clipping_ratio\{channel="1",interface_id="iface_x32_usb",node_id="node_x32_test"\} 1/,
  );
  assert.match(output, /rakkr_health_events_active\{severity="critical",status="open"\} 1/);
  assert.match(output, /rakkr_recording_watchdog_alerts_active\{severity="critical"\} 1/);
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
