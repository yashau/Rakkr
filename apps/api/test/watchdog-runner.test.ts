import assert from "node:assert/strict";
import test from "node:test";
import type { MeterFrame, RecorderNode, RecordingSummary, WatchdogPolicy } from "@rakkr/shared";

import { createAuditStore } from "../src/audit-store.js";
import { createHealthEventStore } from "../src/health-store.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import {
  channelCorrelationEventType,
  createWatchdogRunner,
  nodeOfflineEventType,
} from "../src/watchdog-runner.js";

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

test("repeats unresolved scheduled low-signal alerts after policy interval", async () => {
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const firstRunAt = new Date();
  const policy: WatchdogPolicy = {
    ...watchdogPolicy(),
    qualityMode: "signal_only",
    repeatEverySeconds: 1,
  };
  const runner = createWatchdogRunner({
    auditStore,
    healthEventStore,
    meterFrameProvider: () => silentFrame(),
    policies: [policy],
    recordingStore: memoryRecordingStore([
      recording({
        recordedAt: new Date(firstRunAt.getTime() - 120_000).toISOString(),
        watchdogPolicyId: policy.id,
      }),
    ]),
  });

  const [created] = await runner.runOnce(firstRunAt);
  const [repeated] = await runner.runOnce(new Date(firstRunAt.getTime() + 2_000));
  const [event] = await healthEventStore.list({ recordingId: "rec_watchdog_quality" });
  const repeatedAudits = await auditStore.list({
    action: "health.watchdog.low_signal.repeated",
  });

  assert.equal(created?.outcome, "alert_created");
  assert.equal(repeated?.outcome, "alert_repeated");
  assert.equal(event?.details.repeatCount, 1);
  assert.equal(repeatedAudits.length, 1);
});

test("resolves scheduled low-signal alerts when signal recovers", async () => {
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  let frame = silentFrame();
  const runner = createWatchdogRunner({
    auditStore,
    healthEventStore,
    meterFrameProvider: () => frame,
    policies: [
      {
        ...watchdogPolicy(),
        qualityMode: "signal_only",
      },
    ],
    recordingStore: memoryRecordingStore([recording()]),
  });

  const [created] = await runner.runOnce(new Date("2026-06-18T12:01:00.000Z"));
  frame = speechFrame();
  const [resolved] = await runner.runOnce(new Date("2026-06-18T12:02:00.000Z"));
  const [event] = await healthEventStore.list({ recordingId: "rec_watchdog_quality" });
  const resolvedAudits = await auditStore.list({
    action: "health.watchdog.low_signal.resolved",
  });

  assert.equal(created?.outcome, "alert_created");
  assert.equal(resolved?.outcome, "alert_resolved");
  assert.equal(event?.status, "resolved");
  assert.equal(event?.details.autoResolvedReason, "signal_above_threshold");
  assert.equal(resolvedAudits.length, 1);
});

test("creates and resolves scheduled channel correlation alerts from policy", async () => {
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  let frame = correlatedSpeechFrame();
  const policy: WatchdogPolicy = {
    ...watchdogPolicy(),
    channelCorrelationMode: "alert_on_high",
    channelCorrelationThreshold: 0.98,
    minCumulativeChannelCorrelationSeconds: 30,
    qualityMode: "signal_only",
  };
  const runner = createWatchdogRunner({
    auditStore,
    healthEventStore,
    meterFrameProvider: () => frame,
    policies: [policy],
    recordingStore: memoryRecordingStore([recording()]),
  });

  await runner.runOnce(new Date("2026-06-18T12:00:30.000Z"));
  const createdResults = await runner.runOnce(new Date("2026-06-18T12:01:00.000Z"));
  const [openEvent] = await healthEventStore.list({ recordingId: "rec_watchdog_quality" });

  frame = speechFrame();

  const resolvedResults = await runner.runOnce(new Date("2026-06-18T12:02:01.000Z"));
  const [resolvedEvent] = await healthEventStore.list({ recordingId: "rec_watchdog_quality" });
  const createdAudit = await auditStore.list({
    action: "health.watchdog.channel_correlation.created",
  });
  const resolvedAudit = await auditStore.list({
    action: "health.watchdog.channel_correlation.resolved",
  });

  assert.equal(
    createdResults.find((result) => result.reason === "channel_correlation_above_threshold")
      ?.outcome,
    "alert_created",
  );
  assert.equal(openEvent?.type, channelCorrelationEventType);
  assert.equal(openEvent?.details.channelCorrelationAboveThreshold, true);
  assert.equal(openEvent?.details.maxChannelCorrelationScore, 0.99);
  assert.deepEqual(openEvent?.details.latestChannelCorrelationPairs, [
    {
      leftChannelIndex: 1,
      phase: "same",
      rightChannelIndex: 2,
      score: 0.99,
    },
  ]);
  assert.equal(
    resolvedResults.find((result) => result.reason === "channel_correlation_below_threshold")
      ?.outcome,
    "alert_resolved",
  );
  assert.equal(resolvedEvent?.status, "resolved");
  assert.equal(resolvedEvent?.details.autoResolvedReason, "channel_correlation_below_threshold");
  assert.equal(createdAudit.length, 1);
  assert.equal(resolvedAudit.length, 1);
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

function silentFrame(): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:01:00.000Z",
    interfaceId: "iface_noise",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Input 1",
        peakDbfs: -88,
        quality: {
          crestFactorDb: 0,
          noiseScore: 0,
          speechLike: false,
          speechScore: 0,
          zeroCrossingRate: 0,
        },
        rmsDbfs: -92,
      },
    ],
    nodeId: "node_quality",
  };
}

function speechFrame(): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:02:00.000Z",
    interfaceId: "iface_noise",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Input 1",
        peakDbfs: -8,
        quality: {
          crestFactorDb: 14,
          noiseScore: 0.18,
          speechLike: true,
          speechScore: 0.84,
          zeroCrossingRate: 0.11,
        },
        rmsDbfs: -21,
      },
    ],
    nodeId: "node_quality",
  };
}

function correlatedSpeechFrame(): MeterFrame {
  return {
    ...speechFrame(),
    levels: [
      {
        ...speechFrame().levels[0]!,
        quality: {
          ...speechFrame().levels[0]!.quality!,
          channelCorrelation: {
            peerChannelIndex: 2,
            phase: "same",
            score: 0.99,
          },
        },
      },
      {
        channelIndex: 2,
        clipping: false,
        label: "Input 2",
        peakDbfs: -8,
        quality: {
          channelCorrelation: {
            peerChannelIndex: 1,
            phase: "same",
            score: 0.99,
          },
          crestFactorDb: 14,
          noiseScore: 0.18,
          speechLike: true,
          speechScore: 0.84,
          zeroCrossingRate: 0.11,
        },
        rmsDbfs: -21,
      },
    ],
  };
}

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
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
    ...input,
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
