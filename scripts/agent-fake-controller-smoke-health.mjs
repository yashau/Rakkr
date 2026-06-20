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

function fakeDfCommandPath(fakeDfPath) {
  return path.join(fakeDfPath, process.platform === "win32" ? "df.cmd" : "df");
}
