import path from "node:path";

import { invariant, readJsonLines, waitFor } from "./agent-fake-controller-smoke-utils.mjs";

export async function runSystemHealthScenario({
  address,
  captureCommand,
  createObserved,
  fakeDfPath,
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
    extraAgentArgs: ["--system-health-df-command", fakeDfCommandPath(fakeDfPath)],
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
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.system.disk_pressure",
  );
  const localEvent = healthLogEvents.find((event) => event.type === "agent.system.disk_pressure");

  invariant(syncedEvent?.severity === "warning", "system health disk event was not warning");
  invariant(
    syncedEvent?.details?.usedPercent === 90,
    "system health disk event did not use fake df pressure",
  );
  invariant(localEvent, "system health disk pressure event was not written locally");
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

  invariant(failedEvent?.severity === "warning", "monitor chunk failure was not warning");
  invariant(
    String(failedEvent?.details?.error).includes("controller rejected monitor chunk with 503"),
    "monitor chunk failure did not preserve controller rejection",
  );
  invariant(recoveredEvent?.severity === "info", "monitor chunk recovery was not info");
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
  invariant(recoveredEvent?.severity === "info", "node config sync recovery was not info");
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
