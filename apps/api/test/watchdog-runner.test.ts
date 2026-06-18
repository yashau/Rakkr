import assert from "node:assert/strict";
import test from "node:test";
import type { MeterFrame, RecordingSummary, WatchdogPolicy } from "@rakkr/shared";

import { createAuditStore } from "../src/audit-store.js";
import { createHealthEventStore } from "../src/health-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import { createWatchdogRunner } from "../src/watchdog-runner.js";

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

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
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
