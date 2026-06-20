import path from "node:path";
import { readFile } from "node:fs/promises";

import { invariant, waitFor } from "./agent-fake-controller-smoke-utils.mjs";

export async function runTemplateMeterScenario({
  address,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
  spawnDaemonAgent,
  templateMeterCommand,
}) {
  const stateFile = path.join(smokeRoot, "template-meter-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "template-meter-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: { expectSuccess: true, name: "template-meter" },
  });
  const child = spawnDaemonAgent({
    address,
    captureCommand: templateMeterCommand,
    extraAgentArgs: [
      "--capture-device",
      "fake-template-meter-device",
      "--meter-backend",
      "alsa",
      "--meter-args-template",
      "--template-meter --target {device} --rate {sample_rate} --channels {channels} --format {format} --duration {seconds} --raw {output}",
    ],
    extraEnv: {
      RAKKR_SYSTEM_HEALTH_ENABLED: "false",
    },
    healthLogFile,
    renderCommand,
    stateFile,
  });

  try {
    await waitFor(
      () => observed.meterFrames >= 1 && observed.monitorChunks.length >= 1,
      20_000,
      () =>
        `meters=${observed.meterFrames} monitor=${observed.monitorChunks.length} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const failures = observed.healthEvents.filter((event) =>
    ["critical", "warning"].includes(event.severity),
  );
  const meterArgs = JSON.parse(
    await readFile(path.join(smokeRoot, "fake-template-meter-args.json"), "utf8"),
  );
  invariant(
    failures.length === 0,
    `template meter emitted health failures: ${failures.map((event) => event.type).join(",")}`,
  );
  invariant(meterArgs.includes("--template-meter"), "template meter marker was not passed");
  invariant(
    meterArgs.includes("fake-template-meter-device"),
    "template meter device was not expanded",
  );
  setActiveScenario(undefined);
}
