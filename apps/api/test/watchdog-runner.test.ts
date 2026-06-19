import assert from "node:assert/strict";
import test from "node:test";
import type { MeterFrame, RecorderNode, RecordingSummary, WatchdogPolicy } from "@rakkr/shared";

import { createAuditStore } from "../src/audit-store.js";
import { createHealthEventStore } from "../src/health-store.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import { createWatchdogRunner, nodeOfflineEventType } from "../src/watchdog-runner.js";

test("keeps signal-only watchdog policies compatible with loud non-speech audio", async () => {
  const runner = runnerFor({
    policy: {
      ...watchdogPolicy(),
      qualityMode: "signal_only",
    },
  });

  await runner.runOnce(new Date("2026-06-18T12:00:30.000Z"));
  const [result] = await runner.runOnce(new Date("2026-06-18T12:01:00.000Z"));

  assert.equal(result?.outcome, "healthy");
});

test("alerts when scheduled audio is loud but not speech-like", async () => {
  const healthEventStore = createHealthEventStore("", []);
  const runner = runnerFor({
    healthEventStore,
    policy: watchdogPolicy(),
  });

  await runner.runOnce(new Date("2026-06-18T12:00:30.000Z"));
  const [result] = await runner.runOnce(new Date("2026-06-18T12:01:00.000Z"));
  const [event] = await healthEventStore.list({ recordingId: "rec_watchdog_quality" });

  assert.equal(result?.outcome, "alert_created");
  assert.equal(event?.details.signalBelowThreshold, false);
  assert.equal(event?.details.speechBelowThreshold, true);
  assert.equal(event?.details.maxSpeechScore, 0.2);
  assert.equal(event?.details.maxNoiseScore, 0.91);
});

test("creates and resolves stale node heartbeat health events", async () => {
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const nodes = [node({ lastSeenAt: "2026-06-18T12:00:00.000Z", status: "online" })];
  const runner = createWatchdogRunner({
    auditStore,
    healthEventStore,
    nodeStore: memoryNodeStore(nodes),
    recordingStore: memoryRecordingStore([]),
  });

  const [created] = await runner.runOnce(new Date("2026-06-18T12:03:00.000Z"));
  const [openEvent] = await healthEventStore.list({ nodeId: "node_quality" });

  assert.equal(created?.outcome, "alert_created");
  assert.equal(openEvent?.type, nodeOfflineEventType);
  assert.equal(openEvent?.details.offlineForSeconds, 180);

  nodes[0] = node({ lastSeenAt: "2026-06-18T12:03:10.000Z", status: "online" });

  const [resolved] = await runner.runOnce(new Date("2026-06-18T12:03:11.000Z"));
  const [resolvedEvent] = await healthEventStore.list({ nodeId: "node_quality" });
  const createdAudits = await auditStore.list({ action: "health.watchdog.node_offline.created" });
  const resolvedAudits = await auditStore.list({
    action: "health.watchdog.node_offline.resolved",
  });

  assert.equal(resolved?.outcome, "alert_resolved");
  assert.equal(resolvedEvent?.status, "resolved");
  assert.equal(createdAudits.length, 1);
  assert.equal(resolvedAudits.length, 1);
});

function runnerFor({
  healthEventStore = createHealthEventStore("", []),
  policy,
}: {
  healthEventStore?: ReturnType<typeof createHealthEventStore>;
  policy: WatchdogPolicy;
}) {
  return createWatchdogRunner({
    auditStore: createAuditStore(""),
    healthEventStore,
    meterFrameProvider: () => loudNoiseFrame(),
    policies: [policy],
    recordingStore: memoryRecordingStore([recording()]),
  });
}

function watchdogPolicy(): WatchdogPolicy {
  return {
    activeDuring: "scheduled_recording",
    graceSeconds: 0,
    id: "speech-required-watchdog",
    metric: "rms",
    minCumulativeSecondsAboveThreshold: 1,
    minCumulativeSpeechSeconds: 20,
    minSpeechScore: 0.7,
    name: "Speech Required Watchdog",
    qualityMode: "speech_required",
    repeatEverySeconds: 900,
    severity: "warning",
    thresholdDbfs: -45,
    windowSeconds: 60,
  };
}

function loudNoiseFrame(): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:01:00.000Z",
    interfaceId: "iface_noise",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Input 1",
        peakDbfs: -6,
        quality: {
          crestFactorDb: 5,
          noiseScore: 0.91,
          speechLike: false,
          speechScore: 0.2,
          zeroCrossingRate: 0.48,
        },
        rmsDbfs: -18,
      },
    ],
    nodeId: "node_quality",
  };
}

function recording(): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "Meetings/Quality",
    healthStatus: "unknown",
    id: "rec_watchdog_quality",
    name: "Quality Watchdog Test",
    nodeId: "node_quality",
    recordedAt: "2026-06-18T12:00:00.000Z",
    scheduleId: "sched_quality",
    source: "schedule",
    status: "recording",
    tags: ["quality"],
    watchdogPolicyId: "speech-required-watchdog",
  };
}

function node(input: Pick<RecorderNode, "lastSeenAt" | "status">): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Council Chamber",
    hostname: "rakkr-node",
    id: "node_quality",
    interfaces: [],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: input.lastSeenAt,
    location: {
      room: "Council Chamber",
      site: "Main Office",
    },
    status: input.status,
    tags: ["voice"],
  };
}

function memoryNodeStore(nodes: RecorderNode[]): Pick<NodeStore, "list"> {
  return {
    async list() {
      return nodes;
    },
  };
}

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((recording) => recording.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      } else {
        recordings.unshift(recording);
      }
    },
  };
}
