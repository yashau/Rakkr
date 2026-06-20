import { invariant } from "./agent-fake-controller-smoke-utils.mjs";

export function assertStalledCaptureScenario({ healthLogEvents, job, observed, scenario, state }) {
  const stalledLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_output_stalled",
  );

  invariant(job.status === "failed", "fake controller did not mark stalled capture job failed");
  invariant(observed.failures === 1, "agent did not mark stalled capture job failed");
  invariant(!observed.cacheUpload, "agent uploaded cache after stalled capture");
  invariant(state.status === "failed", "stalled capture state file did not end failed");
  invariant(state.jobId === scenario.jobId, "stalled capture state recorded the wrong job id");
  invariant(
    String(state.reason).includes("capture output stalled"),
    "stalled capture state did not retain the stall reason",
  );
  invariant(
    String(observed.failureReason).includes("capture output stalled"),
    "stalled capture failed-job reason did not include the stall",
  );
  invariant(stalledLocalEvent, "agent local health log did not include capture output stall");
  invariant(stalledLocalEvent.severity === "critical", "stalled capture was not critical");
  invariant(
    observed.healthEvents.some((event) => event.type === stalledLocalEvent.type),
    "agent did not sync capture output stall health event",
  );
}

export function assertCacheUploadFailureScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  const failedLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.cache_upload_failed",
  );

  invariant(job.status === "failed", "fake controller did not mark failed cache upload job failed");
  invariant(observed.failures === 1, "agent did not mark cache upload failure job failed");
  invariant(
    String(observed.failureReason).includes("controller rejected cache file with 503"),
    "agent failed-job reason did not include rejected cache upload",
  );
  invariant(
    state.status === "failed",
    "agent state file did not end failed after cache upload failure",
  );
  invariant(state.jobId === scenario.jobId, "failed agent state file recorded the wrong job id");
  invariant(
    state.outputPath?.endsWith(scenario.outputFileName),
    "failed state did not retain rendered output path",
  );
  invariant(
    String(state.reason).includes("controller rejected cache file with 503"),
    "failed state did not retain cache upload rejection reason",
  );
  invariant(
    observed.healthEvents.some((event) => event.type === "agent.recording_job.cache_upload_failed"),
    "agent did not report cache upload failure",
  );
  invariant(failedLocalEvent, "agent local health log did not include cache upload failure");
  invariant(
    failedLocalEvent.severity === "warning",
    "cache upload local health event did not record warning severity",
  );
  invariant(
    failedLocalEvent.recordingId === scenario.recordingId,
    "cache upload local health event recorded the wrong recording",
  );
  invariant(
    failedLocalEvent.details?.jobId === scenario.jobId,
    "cache upload local health event recorded the wrong job",
  );
}
