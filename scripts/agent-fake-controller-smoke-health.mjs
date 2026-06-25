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
        observed.meterFrames >= 2,
      20_000,
      () =>
        `heartbeats=${observed.nodeHeartbeats} meters=${observed.meterFrames} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
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

export async function runMeterXrunScenario({
  address,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
  xrunMeterCommand,
}) {
  const stateFile = path.join(smokeRoot, "meter-xrun-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "meter-xrun-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({ jobs: [], observed, scenario: { expectSuccess: true, name: "meter-xrun" } });
  const child = spawnDaemonAgent({
    address,
    captureCommand: xrunMeterCommand,
    extraAgentArgs: ["--meter-backend", "alsa"],
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.meter.xrun") &&
        observed.meterFrames >= 1 &&
        observed.monitorChunks.length >= 1,
      20_000,
      () =>
        `meters=${observed.meterFrames} monitor=${observed.monitorChunks.length} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const healthLogEvents = await readJsonLines(healthLogFile);
  const syncedEvent = observed.healthEvents.find((event) => event.type === "agent.meter.xrun");

  invariant(syncedEvent?.severity === "warning", "meter xrun event was not warning");
  invariant(
    syncedEvent?.details?.usingSyntheticFallback === true,
    "meter xrun did not report synthetic fallback",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.meter.xrun"),
    "meter xrun event was not written locally",
  );
  setActiveScenario(undefined);
}

export async function runMeterFrameSyncRecoveryScenario({
  address,
  captureCommand,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "meter-frame-sync-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "meter-frame-sync-recovery-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      expectSuccess: true,
      meterFrameFailuresRemaining: 1,
      name: "meter-frame-sync-recovery",
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
        observed.healthEvents.some((event) => event.type === "agent.meter_frame.sync_failed") &&
        observed.healthEvents.some((event) => event.type === "agent.meter_frame.sync_recovered") &&
        observed.meterFrameFailures === 1 &&
        observed.meterFrames >= 1,
      20_000,
      () =>
        `meterFailures=${observed.meterFrameFailures} meters=${observed.meterFrames} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const healthLogEvents = await readJsonLines(healthLogFile);
  const failedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.meter_frame.sync_failed",
  );
  const recoveredEvent = observed.healthEvents.find(
    (event) => event.type === "agent.meter_frame.sync_recovered",
  );

  invariant(failedEvent?.severity === "warning", "meter-frame sync failure was not warning");
  invariant(
    String(failedEvent?.details?.error).includes("controller rejected meter frame with 503"),
    "meter-frame sync failure did not preserve controller rejection",
  );
  invariant(
    failedEvent?.details?.interfaceId === "iface_default_capture",
    "meter-frame sync failure did not preserve interface id",
  );
  invariant(
    failedEvent?.details?.channelCount === 2,
    "meter-frame sync failure did not preserve channel count",
  );
  invariant(recoveredEvent?.severity === "info", "meter-frame sync recovery was not info");
  invariant(
    recoveredEvent?.details?.interfaceId === failedEvent.details.interfaceId,
    "meter-frame sync recovery did not preserve interface id",
  );
  invariant(
    recoveredEvent?.details?.channelCount === failedEvent.details.channelCount,
    "meter-frame sync recovery did not preserve channel count",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.meter_frame.sync_failed"),
    "meter-frame sync failure event was not written locally",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.meter_frame.sync_recovered"),
    "meter-frame sync recovery event was not written locally",
  );
  setActiveScenario(undefined);
}

export async function runMeterDeviceUnavailableScenario({
  address,
  createObserved,
  deviceUnavailableMeterCommand,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "meter-device-unavailable-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "meter-device-unavailable-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: { expectSuccess: true, name: "meter-device-unavailable" },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand: deviceUnavailableMeterCommand,
    extraAgentArgs: ["--meter-backend", "alsa"],
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.meter.device_unavailable") &&
        observed.meterFrames >= 1 &&
        observed.monitorChunks.length >= 1,
      20_000,
      () =>
        `meters=${observed.meterFrames} monitor=${observed.monitorChunks.length} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const healthLogEvents = await readJsonLines(healthLogFile);
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.meter.device_unavailable",
  );

  invariant(
    syncedEvent?.severity === "critical",
    "meter device unavailable event was not critical",
  );
  invariant(
    syncedEvent?.details?.usingSyntheticFallback === true,
    "meter device unavailable did not report synthetic fallback",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.meter.device_unavailable"),
    "meter device unavailable event was not written locally",
  );
  setActiveScenario(undefined);
}

export async function runMeterCaptureFailedScenario({
  address,
  captureFailedMeterCommand,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "meter-capture-failed-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "meter-capture-failed-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: { expectSuccess: true, name: "meter-capture-failed" },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand: captureFailedMeterCommand,
    extraAgentArgs: ["--meter-backend", "alsa"],
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.meter.capture_failed") &&
        observed.meterFrames >= 1 &&
        observed.monitorChunks.length >= 1,
      20_000,
      () =>
        `meters=${observed.meterFrames} monitor=${observed.monitorChunks.length} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const healthLogEvents = await readJsonLines(healthLogFile);
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.meter.capture_failed",
  );

  invariant(syncedEvent?.severity === "warning", "meter capture failure was not warning");
  invariant(
    syncedEvent?.details?.classification === "capture_failed",
    "meter capture failure did not preserve generic classification",
  );
  invariant(
    syncedEvent?.details?.usingSyntheticFallback === true,
    "meter capture failure did not report synthetic fallback",
  );
  invariant(
    !observed.healthEvents.some((event) => event.type === "agent.meter.xrun"),
    "generic meter capture failure was misclassified as xrun",
  );
  invariant(
    !observed.healthEvents.some((event) => event.type === "agent.meter.device_unavailable"),
    "generic meter capture failure was misclassified as device unavailable",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.meter.capture_failed"),
    "meter capture failure event was not written locally",
  );
  setActiveScenario(undefined);
}

export async function runMeterRecoveryScenario({
  address,
  createObserved,
  recoveringMeterCommand,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "meter-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "meter-recovery-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: { expectSuccess: true, name: "meter-recovery" },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand: recoveringMeterCommand,
    extraAgentArgs: ["--meter-backend", "alsa"],
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () =>
        observed.healthEvents.some((event) => event.type === "agent.meter.xrun") &&
        observed.healthEvents.some((event) => event.type === "agent.meter.capture_recovered") &&
        observed.meterFrames >= 2,
      20_000,
      () =>
        `meters=${observed.meterFrames} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const healthLogEvents = await readJsonLines(healthLogFile);
  const recoveryEvent = observed.healthEvents.find(
    (event) => event.type === "agent.meter.capture_recovered",
  );

  invariant(recoveryEvent?.severity === "info", "meter recovery event was not info");
  invariant(
    recoveryEvent?.details?.previousType === "agent.meter.xrun",
    "meter recovery did not preserve previous xrun type",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.meter.capture_recovered"),
    "meter recovery event was not written locally",
  );
  setActiveScenario(undefined);
}

export async function runMonitorChunkRecoveryScenario({
  address,
  captureCommand,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
}) {
  const stateFile = path.join(smokeRoot, "monitor-chunk-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "monitor-chunk-recovery-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      expectSuccess: true,
      monitorChunkFailuresRemaining: 1,
      name: "monitor-chunk-recovery",
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
        observed.healthEvents.some(
          (event) => event.type === "agent.listen_monitor.chunk_sync_failed",
        ) &&
        observed.healthEvents.some(
          (event) => event.type === "agent.listen_monitor.chunk_sync_recovered",
        ) &&
        observed.monitorChunkFailures === 1 &&
        observed.monitorChunks.length >= 1,
      20_000,
      () =>
        `monitorFailures=${observed.monitorChunkFailures} monitor=${observed.monitorChunks.length} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const healthLogEvents = await readJsonLines(healthLogFile);
  const failedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.listen_monitor.chunk_sync_failed",
  );
  const recoveredEvent = observed.healthEvents.find(
    (event) => event.type === "agent.listen_monitor.chunk_sync_recovered",
  );
  const uploadedChunk = observed.monitorChunks.at(0);

  invariant(failedEvent?.severity === "warning", "monitor chunk failure was not warning");
  invariant(
    String(failedEvent?.details?.error).includes("controller rejected monitor chunk with 503"),
    "monitor chunk failure did not preserve controller rejection",
  );
  invariant(
    failedEvent?.details?.contentType === "audio/wav",
    "monitor chunk failure did not preserve content type",
  );
  invariant(
    failedEvent?.details?.durationMs === 1000,
    "monitor chunk failure did not preserve duration",
  );
  invariant(
    failedEvent?.details?.monitorBytes > 44,
    "monitor chunk failure did not preserve monitor bytes",
  );
  invariant(
    failedEvent?.details?.interfaceId === "iface_default_capture",
    "monitor chunk failure did not preserve interface id",
  );
  invariant(recoveredEvent?.severity === "info", "monitor chunk recovery was not info");
  invariant(
    recoveredEvent?.details?.contentType === "audio/wav",
    "monitor chunk recovery did not preserve content type",
  );
  invariant(
    recoveredEvent?.details?.monitorBytes > 44,
    "monitor chunk recovery did not preserve monitor bytes",
  );
  invariant(
    uploadedChunk?.contentType === "audio/wav",
    "fake controller did not receive monitor chunk content type",
  );
  invariant(uploadedChunk?.durationMs === "1000", "fake controller did not receive duration");
  invariant(uploadedChunk?.size > 44, "fake controller did not receive monitor bytes");
  invariant(
    healthLogEvents.some((event) => event.type === "agent.listen_monitor.chunk_sync_failed"),
    "monitor chunk failure event was not written locally",
  );
  invariant(
    healthLogEvents.some((event) => event.type === "agent.listen_monitor.chunk_sync_recovered"),
    "monitor chunk recovery event was not written locally",
  );
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
