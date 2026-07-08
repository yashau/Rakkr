import path from "node:path";

import { invariant, readJsonLines, waitFor } from "./agent-fake-controller-smoke-utils.mjs";

export async function runSystemHealthScenario({
  address,
  captureCommand,
  createObserved,
  fakeDfPath,
  fakeLoadavgPath,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "system-health-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "system-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      expectSuccess: true,
      name: "system-health",
    },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand,
    extraAgentArgs: [
      "--system-health-df-command",
      fakeDfCommandPath(fakeDfPath),
      "--system-health-load-warning-per-core",
      "0.01",
      "--system-health-load-critical-per-core",
      "1000",
      "--system-health-loadavg-path",
      fakeLoadavgPath,
    ],
    extraEnv: {
      PATH: `${fakeDfPath}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.system.disk_pressure") &&
        observed.healthEvents.some((event) => event.type === "agent.system.cpu_pressure") &&
        observed.healthEvents.some((event) => event.type === "agent.system.disk_recovered") &&
        observed.healthEvents.some((event) => event.type === "agent.system.cpu_recovered") &&
        observed.nodeHeartbeats >= 2 &&
        observed.inventoryReconciles >= 1 &&
        observed.meterFrames >= 2,
      20_000,
      () =>
        `heartbeats=${observed.nodeHeartbeats} inventory=${observed.inventoryReconciles} meters=${observed.meterFrames} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const healthLogEvents = await readJsonLines(healthLogFile);
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.system.disk_pressure",
  );
  const cpuEvent = observed.healthEvents.find(
    (event) => event.type === "agent.system.cpu_pressure",
  );
  const diskRecoveryEvent = observed.healthEvents.find(
    (event) => event.type === "agent.system.disk_recovered",
  );
  const cpuRecoveryEvent = observed.healthEvents.find(
    (event) => event.type === "agent.system.cpu_recovered",
  );
  const localEvent = healthLogEvents.find((event) => event.type === "agent.system.disk_pressure");
  const localCpuEvent = healthLogEvents.find(
    (event) => event.type === "agent.system.cpu_pressure",
  );
  const localDiskRecoveryEvent = healthLogEvents.find(
    (event) => event.type === "agent.system.disk_recovered",
  );
  const localCpuRecoveryEvent = healthLogEvents.find(
    (event) => event.type === "agent.system.cpu_recovered",
  );

  invariant(syncedEvent?.severity === "warning", "system health disk event was not warning");
  invariant(
    syncedEvent?.details?.usedPercent === 90,
    "system health disk event did not use fake df pressure",
  );
  invariant(cpuEvent?.severity === "warning", "system health CPU event was not warning");
  invariant(
    cpuEvent?.details?.loadAverageOneMinute === 12.5,
    "system health CPU event did not use fake loadavg pressure",
  );
  invariant(
    cpuEvent?.details?.loadPerCore >= 0.1,
    "system health CPU event did not preserve per-core pressure",
  );
  invariant(diskRecoveryEvent?.severity === "info", "system health disk recovery was not info");
  invariant(
    diskRecoveryEvent?.details?.usedPercent === 10,
    "system health disk recovery did not use fake df recovery",
  );
  invariant(cpuRecoveryEvent?.severity === "info", "system health CPU recovery was not info");
  invariant(
    cpuRecoveryEvent?.details?.loadAverageOneMinute === 0,
    "system health CPU recovery did not use fake loadavg recovery",
  );
  invariant(localEvent, "system health disk pressure event was not written locally");
  invariant(localCpuEvent, "system health CPU pressure event was not written locally");
  invariant(localDiskRecoveryEvent, "system health disk recovery event was not written locally");
  invariant(localCpuRecoveryEvent, "system health CPU recovery event was not written locally");
  setActiveScenario(undefined);
}

export async function runClockSkewRecoveryScenario({
  address,
  captureCommand,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "clock-skew-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "clock-skew-recovery-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      expectSuccess: true,
      name: "clock-skew-recovery",
      nodeHeartbeatDateHeaders: [
        () => new Date(Date.now() + 10_000).toUTCString(),
        () => new Date().toUTCString(),
      ],
    },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.system.clock_skew") &&
        observed.healthEvents.some(
          (event) => event.type === "agent.system.clock_skew_recovered",
        ) &&
        observed.nodeHeartbeats >= 2,
      20_000,
      () =>
        `heartbeats=${observed.nodeHeartbeats} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const healthLogEvents = await readJsonLines(healthLogFile);
  const skewEvent = observed.healthEvents.find(
    (event) => event.type === "agent.system.clock_skew",
  );
  const recoveredEvent = observed.healthEvents.find(
    (event) => event.type === "agent.system.clock_skew_recovered",
  );
  const localSkewEvent = healthLogEvents.find(
    (event) => event.type === "agent.system.clock_skew",
  );
  const localRecoveredEvent = healthLogEvents.find(
    (event) => event.type === "agent.system.clock_skew_recovered",
  );

  invariant(skewEvent?.severity === "warning", "clock skew event was not warning");
  invariant(
    skewEvent?.details?.absoluteSkewSeconds > 5,
    "clock skew event did not preserve warning skew evidence",
  );
  invariant(
    skewEvent?.details?.warningSeconds === 5,
    "clock skew event did not include warning threshold",
  );
  invariant(recoveredEvent?.severity === "info", "clock skew recovery was not info");
  invariant(
    recoveredEvent?.details?.absoluteSkewSeconds <= 2,
    "clock skew recovery did not preserve recovered skew evidence",
  );
  invariant(localSkewEvent, "clock skew event was not written locally");
  invariant(localRecoveredEvent, "clock skew recovery event was not written locally");
  setActiveScenario(undefined);
}

export async function runNodeHeartbeatRecoveryScenario({
  address,
  captureCommand,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "node-heartbeat-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "node-heartbeat-recovery-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      expectSuccess: true,
      name: "node-heartbeat-recovery",
      nodeHeartbeatFailuresRemaining: 1,
    },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.node_heartbeat.sync_failed") &&
        observed.healthEvents.some(
          (event) => event.type === "agent.node_heartbeat.sync_recovered",
        ) &&
        observed.nodeHeartbeatFailures === 1 &&
        observed.nodeHeartbeats >= 1,
      20_000,
      () =>
        `heartbeats=${observed.nodeHeartbeats} heartbeatFailures=${observed.nodeHeartbeatFailures} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const healthLogEvents = await readJsonLines(healthLogFile);
  const failedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.node_heartbeat.sync_failed",
  );
  const recoveredEvent = observed.healthEvents.find(
    (event) => event.type === "agent.node_heartbeat.sync_recovered",
  );

  invariant(failedEvent?.severity === "warning", "node heartbeat sync failure was not warning");
  invariant(
    String(failedEvent?.details?.error).includes("controller rejected node heartbeat with 503"),
    "node heartbeat sync failure did not preserve controller rejection",
  );
  invariant(
    failedEvent?.details?.nodeId === "node_fake_controller_smoke",
    "node heartbeat sync failure did not preserve node id",
  );
  invariant(
    failedEvent?.details?.alias === "Local Recorder Node",
    "node heartbeat sync failure did not preserve node alias",
  );
  invariant(
    failedEvent?.details?.status === "online",
    "node heartbeat sync failure did not preserve node status",
  );
  invariant(
    failedEvent?.details?.interfaceCount >= 1,
    "node heartbeat sync failure did not preserve interface count",
  );
  invariant(
    Array.isArray(failedEvent?.details?.audioBackends),
    "node heartbeat sync failure did not preserve audio backends",
  );
  invariant(recoveredEvent?.severity === "info", "node heartbeat sync recovery was not info");
  invariant(
    recoveredEvent?.details?.nodeId === failedEvent.details.nodeId,
    "node heartbeat sync recovery did not preserve node id",
  );
  invariant(
    recoveredEvent?.details?.interfaceCount >= 1,
    "node heartbeat sync recovery did not preserve interface count",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.node_heartbeat.sync_failed"),
    "node heartbeat sync failure event was not written locally",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.node_heartbeat.sync_recovered"),
    "node heartbeat sync recovery event was not written locally",
  );
  setActiveScenario(undefined);
}

export async function runNodeConfigRecoveryScenario({
  address,
  captureCommand,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "node-config-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "node-config-recovery-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      expectSuccess: true,
      name: "node-config-recovery",
      nodeConfigFailuresRemaining: 1,
    },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.node_config.sync_failed") &&
        observed.healthEvents.some((event) => event.type === "agent.node_config.sync_recovered") &&
        observed.nodeConfigFailures === 1 &&
        observed.configReads >= 2,
      20_000,
      () =>
        `configReads=${observed.configReads} configFailures=${observed.nodeConfigFailures} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const healthLogEvents = await readJsonLines(healthLogFile);
  const failedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.node_config.sync_failed",
  );
  const recoveredEvent = observed.healthEvents.find(
    (event) => event.type === "agent.node_config.sync_recovered",
  );

  invariant(failedEvent?.severity === "warning", "node config sync failure was not warning");
  invariant(
    String(failedEvent?.details?.error).includes(
      "controller rejected node config request with 503",
    ),
    "node config sync failure did not preserve controller rejection",
  );
  invariant(
    failedEvent?.details?.nodeId === "node_fake_controller_smoke",
    "node config sync failure did not preserve node id",
  );
  invariant(
    failedEvent?.details?.maxConcurrentRecordings === null,
    "node config sync failure should not invent capacity evidence",
  );
  invariant(recoveredEvent?.severity === "info", "node config sync recovery was not info");
  invariant(
    recoveredEvent?.details?.nodeId === failedEvent.details.nodeId,
    "node config sync recovery did not preserve node id",
  );
  invariant(
    recoveredEvent?.details?.maxConcurrentRecordings === 1,
    "node config sync recovery did not preserve capacity",
  );
  invariant(
    recoveredEvent?.details?.recorderCachePolicyCount === 0,
    "node config sync recovery did not preserve recorder-cache policy count",
  );
  invariant(
    recoveredEvent?.details?.audioDefaultsConfigured === false,
    "node config sync recovery did not preserve audio-default state",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.node_config.sync_failed"),
    "node config sync failure event was not written locally",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.node_config.sync_recovered"),
    "node config sync recovery event was not written locally",
  );
  setActiveScenario(undefined);
}

function fakeDfCommandPath(fakeDfPath) {
  return path.join(fakeDfPath, process.platform === "win32" ? "df.cmd" : "df");
}

export async function runAudioBackendRecoveryScenario({
  address,
  captureCommand,
  createObserved,
  fakeArecordCommand,
  fakeArecordPath,
  fakeProcAsoundPcmPath,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "audio-backend-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "audio-backend-recovery-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: { expectSuccess: true, name: "audio-backend-recovery" },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand,
    extraAgentArgs: [
      "--inventory-arecord-command",
      fakeArecordCommand,
      "--inventory-proc-asound-pcm-path",
      fakeProcAsoundPcmPath,
    ],
    extraEnv: {
      PATH: `${fakeArecordPath}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.audio_backend.unavailable") &&
        observed.healthEvents.some((event) => event.type === "agent.audio_backend.recovered") &&
        observed.nodeHeartbeats >= 1 &&
        observed.meterFrames >= 1,
      20_000,
      () =>
        `heartbeats=${observed.nodeHeartbeats} meters=${observed.meterFrames} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const healthLogEvents = await readJsonLines(healthLogFile);
  const unavailableEvent = observed.healthEvents.find(
    (event) => event.type === "agent.audio_backend.unavailable",
  );
  const recoveredEvent = observed.healthEvents.find(
    (event) => event.type === "agent.audio_backend.recovered",
  );

  invariant(unavailableEvent?.severity === "warning", "audio backend unavailable was not warning");
  invariant(
    unavailableEvent?.details?.availableInterfaces === 0,
    "audio backend unavailable did not report zero available interfaces",
  );
  invariant(
    unavailableEvent?.details?.interfaces === 1,
    "audio backend unavailable did not preserve fallback interface count",
  );
  invariant(
    unavailableEvent?.details?.audioBackends?.includes("unknown"),
    "audio backend unavailable did not preserve unknown backend evidence",
  );
  invariant(recoveredEvent?.severity === "info", "audio backend recovery was not info");
  invariant(
    recoveredEvent?.details?.availableInterfaces === 1,
    "audio backend recovery did not report available interface",
  );
  invariant(
    recoveredEvent?.details?.audioBackends?.includes("alsa"),
    "audio backend recovery did not preserve recovered ALSA backend",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.audio_backend.unavailable"),
    "audio backend unavailable event was not written locally",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.audio_backend.recovered"),
    "audio backend recovery event was not written locally",
  );
  setActiveScenario(undefined);
}
