import path from "node:path";

import { readJsonLines } from "./agent-fake-controller-smoke-utils.mjs";

// Fresh controller-observed counters for one scenario run.
export function createObserved() {
  return {
    cancelReason: undefined,
    cancellations: 0,
    cacheUpload: undefined,
    cacheUploads: [],
    channelMapReads: 0,
    channelMapFailures: 0,
    claimNextReads: 0,
    claims: 0,
    configReads: 0,
    failureReason: undefined,
    failures: 0,
    heartbeats: 0,
    healthEvents: [],
    inventoryReconciles: 0,
    jobStatusReads: 0,
    jobStatusReadFailures: 0,
    claimNextReadFailures: 0,
    jobHeartbeatFailures: 0,
    maxRunningJobs: 0,
    meterFrames: 0,
    monitorChunkFailures: 0,
    monitorChunks: [],
    nextReads: 0,
    nodeConfigFailures: 0,
    nodeHeartbeatFailures: 0,
    nodeHeartbeats: 0,
  };
}

// Bind the smoke node id so `createJob(scenario)` keeps its single-argument shape
// (the recovery scenarios receive `createJob` in their deps and call it that way).
export function makeCreateJob(nodeId) {
  return function createJob(scenario) {
    return {
      command: {
        captureChannels: scenario.captureChannels ?? 1,
        captureDevice: "fake-device",
        captureFormat: "S16_LE",
        captureInterfaceId: scenario.captureInterfaceId ?? null,
        captureSampleRate: 48000,
        channelMap: scenario.channelMap ?? null,
        durationSeconds: scenario.durationSeconds ?? 1,
        outputBitrateKbps: 128,
        outputCodec: "mp3",
        outputFileName: scenario.outputFileName,
        outputVbr: true,
        recorderCacheRetention: scenario.recorderCacheRetention ?? immediateRetention(),
        type: "alsa_capture",
      },
      failureReason: undefined,
      id: scenario.jobId,
      nodeId,
      recordingId: scenario.recordingId,
      status: "queued",
    };
  };
}

function immediateRetention() {
  return {
    deleteAfterUpload: true,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: null,
    policyId: "retention-recorder-cache-smoke",
  };
}

export function deferredSweepRetention() {
  return {
    deleteAfterUpload: false,
    maxAgeDays: null,
    maxBytes: 1,
    minFreeDiskPercent: null,
    policyId: "retention-recorder-cache-sweep-smoke",
  };
}

export function minFreeSweepRetention() {
  return {
    deleteAfterUpload: false,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: 95,
    policyId: "retention-recorder-cache-min-free-smoke",
  };
}

export function recorderCachePoliciesForScenario(scenario) {
  if (scenario.recorderCachePolicySequence) {
    const index = Math.min(
      scenario.recorderCachePolicySequenceIndex ?? 0,
      scenario.recorderCachePolicySequence.length - 1,
    );
    scenario.recorderCachePolicySequenceIndex = index + 1;

    return scenario.recorderCachePolicySequence[index];
  }

  if (scenario.recorderCachePolicies) {
    return scenario.recorderCachePolicies;
  }

  if (scenario.deferredSweep) {
    return [deferredSweepRetention()];
  }

  if (scenario.minFreeSweep) {
    return [minFreeSweepRetention()];
  }

  return [];
}

export function fakeDfCommandPath(fakeDfPath) {
  return path.join(fakeDfPath, process.platform === "win32" ? "df.cmd" : "df");
}

// Extra diagnostics folded into a daemon-scenario timeout error: the synced and
// local health-event streams plus the controller-observed counters, so a flake
// shows which job stalled and how far it got — not just the unmet predicate.
export async function daemonScenarioDiagnostics(observed, healthLogFile) {
  const localHealth = await readJsonLines(healthLogFile);

  return (
    `\n--- synced health events (${observed.healthEvents.length}) ---\n` +
    `${observed.healthEvents.map((event) => event.type).join(",")}\n` +
    `--- local health log (${localHealth.length}) ---\n` +
    `${localHealth.map((event) => event.type).join(",")}\n` +
    `--- observed ---\n` +
    `claims=${observed.claims} claimNextReads=${observed.claimNextReads} ` +
    `uploads=${observed.cacheUploads.length} configReads=${observed.configReads} ` +
    `heartbeats=${observed.heartbeats} jobStatusReads=${observed.jobStatusReads} ` +
    `failures=${observed.failures} maxRunningJobs=${observed.maxRunningJobs}`
  );
}
