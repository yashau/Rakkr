import path from "node:path";

import { invariant, readJsonLines, run } from "./agent-fake-controller-smoke-utils.mjs";

export async function runClaimNextFailureScenario({
  address,
  createObserved,
  nodeId,
  repoRoot,
  setActiveScenario,
  smokeRoot,
  token,
}) {
  const healthLogFile = path.join(smokeRoot, "claim-next-failure-health-events.jsonl");
  const observed = createObserved();
  setActiveScenario({
    jobs: [],
    observed,
    scenario: {
      claimNextFailuresRemaining: 1,
      expectSuccess: false,
      name: "claim-next-failure",
    },
  });

  const result = await run(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      path.join(repoRoot, "Cargo.toml"),
      "-p",
      "rakkr-recorder-agent",
      "--",
      "--allow-insecure-controller",
      "--agent-health-log-file",
      healthLogFile,
      "--controller-token",
      token,
      "--controller-url",
      `http://127.0.0.1:${address.port}`,
      "--node-id",
      nodeId,
      "--run-next-job",
    ],
    { cwd: smokeRoot },
  );

  invariant(result.code !== 0, "claim-next failure smoke unexpectedly succeeded");
  const healthLogEvents = await readJsonLines(healthLogFile);
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.claim_next_failed",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.claim_next_failed",
  );

  invariant(observed.claimNextReadFailures === 1, "fake controller did not fail claim-next once");
  invariant(observed.claims === 0, "agent claimed a job after claim-next was rejected");
  invariant(localEvent, "agent local health log did not include claim-next failure");
  invariant(localEvent.severity === "warning", "claim-next failure was not warning");
  invariant(syncedEvent, "agent did not sync claim-next failure health event");
  invariant(
    String(syncedEvent.details?.error).includes("controller rejected next job claim with 503"),
    "claim-next health event did not preserve controller rejection",
  );
  setActiveScenario(undefined);
}
