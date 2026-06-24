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

export function assertRenderFailureScenario({ healthLogEvents, job, observed, scenario, state }) {
  const renderLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.output_render_failed",
  );

  invariant(job.status === "failed", "fake controller did not mark render failure job failed");
  invariant(observed.failures === 1, "agent did not mark render failure job failed");
  invariant(!observed.cacheUpload, "agent uploaded cache after render failure");
  invariant(state.status === "failed", "render failure state file did not end failed");
  invariant(state.jobId === scenario.jobId, "render failure state recorded the wrong job id");
  invariant(
    state.outputPath?.endsWith(".raw.wav"),
    "render failure state did not retain raw capture output",
  );
  invariant(
    String(state.reason).includes("render command"),
    "render failure state did not retain the render reason",
  );
  invariant(
    String(observed.failureReason).includes("render command"),
    "render failure failed-job reason did not include render command",
  );
  invariant(renderLocalEvent, "agent local health log did not include render failure");
  invariant(renderLocalEvent.severity === "critical", "render failure was not critical");
  invariant(
    renderLocalEvent.details?.outputCodec === "mp3",
    "render failure did not retain target output codec",
  );
  invariant(
    observed.healthEvents.some((event) => event.type === renderLocalEvent.type),
    "agent did not sync render failure health event",
  );
}

export function assertCaptureStartFailureScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  assertCaptureFailureHealth({
    eventType: "agent.recording_job.capture_start_failed",
    healthLogEvents,
    job,
    observed,
    reasonFragment: "run capture command",
    scenario,
    state,
  });
}

export function assertCaptureFailureScenario({ healthLogEvents, job, observed, scenario, state }) {
  assertCaptureFailureHealth({
    eventType: "agent.recording_job.capture_failed",
    healthLogEvents,
    job,
    observed,
    reasonFragment: "capture command",
    scenario,
    state,
  });
}

export function assertStatusPollFailureScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  const failedLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.status_poll_failed",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.status_poll_failed",
  );

  invariant(job.status === "failed", "fake controller did not mark status-poll job failed");
  invariant(observed.failures === 1, "agent did not mark status-poll job failed");
  invariant(observed.jobStatusReadFailures === 1, "fake controller did not fail status read once");
  invariant(!observed.cacheUpload, "agent uploaded cache after status-poll failure");
  invariant(state.status === "failed", "status-poll state file did not end failed");
  invariant(state.jobId === scenario.jobId, "status-poll state recorded the wrong job id");
  invariant(
    String(state.reason).includes("controller rejected job status request with 503"),
    "status-poll state did not retain controller rejection",
  );
  invariant(
    String(observed.failureReason).includes("controller rejected job status request with 503"),
    "failed-job reason did not include status-poll rejection",
  );
  invariant(failedLocalEvent, "agent local health log did not include status-poll failure");
  invariant(failedLocalEvent.severity === "warning", "status-poll failure was not warning");
  invariant(
    failedLocalEvent.recordingId === scenario.recordingId,
    "status-poll local health event recorded the wrong recording",
  );
  invariant(
    failedLocalEvent.details?.jobId === scenario.jobId,
    "status-poll local health event recorded the wrong job",
  );
  invariant(syncedEvent, "agent did not sync status-poll failure health event");
  invariant(
    String(syncedEvent.details?.error).includes("controller rejected job status request with 503"),
    "status-poll health event did not preserve controller rejection",
  );
}

export function assertControlPlaneFailureScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  const failedLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.control_plane_failed",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.control_plane_failed",
  );

  invariant(job.status === "failed", "fake controller did not mark control-plane job failed");
  invariant(observed.failures === 1, "agent did not mark control-plane job failed");
  invariant(observed.jobHeartbeatFailures === 1, "fake controller did not fail heartbeat once");
  invariant(!observed.cacheUpload, "agent uploaded cache after control-plane failure");
  invariant(state.status === "failed", "control-plane state file did not end failed");
  invariant(state.jobId === scenario.jobId, "control-plane state recorded the wrong job id");
  invariant(
    String(state.reason).includes("controller rejected job heartbeat with 503"),
    "control-plane state did not retain heartbeat rejection",
  );
  invariant(
    String(observed.failureReason).includes("controller rejected job heartbeat with 503"),
    "failed-job reason did not include heartbeat rejection",
  );
  invariant(failedLocalEvent, "agent local health log did not include control-plane failure");
  invariant(failedLocalEvent.severity === "warning", "control-plane failure was not warning");
  invariant(
    failedLocalEvent.recordingId === scenario.recordingId,
    "control-plane local health event recorded the wrong recording",
  );
  invariant(
    failedLocalEvent.details?.jobId === scenario.jobId,
    "control-plane local health event recorded the wrong job",
  );
  invariant(syncedEvent, "agent did not sync control-plane failure health event");
  invariant(
    String(syncedEvent.details?.error).includes("controller rejected job heartbeat with 503"),
    "control-plane health event did not preserve heartbeat rejection",
  );
}

export function assertRenderedOutputScenario({
  healthLogEvents,
  observed,
  renderedLocalEvent,
  scenario,
}) {
  invariant(
    observed.cacheUpload?.recordingId === scenario.recordingId,
    "agent did not upload cache file",
  );
  invariant(
    observed.cacheUpload?.jobId === scenario.jobId,
    "cache upload did not include the job id",
  );
  invariant(observed.cacheUpload?.durationSeconds === "1", "cache upload did not include duration");
  invariant(
    observed.cacheUpload?.fileName === scenario.outputFileName,
    "cache upload did not include rendered file name",
  );
  invariant(observed.cacheUpload?.contentType === "audio/mpeg", "cache upload was not MP3");
  invariant(observed.cacheUpload?.size > 44, "cache upload body was too small");
  invariant(
    observed.healthEvents.some((event) => event.type === "agent.recording_job.output_rendered"),
    "agent did not report rendered output",
  );
  invariant(renderedLocalEvent, "agent local health log did not include rendered output");
  invariant(
    renderedLocalEvent.severity === "info",
    "rendered local health event did not record info severity",
  );
  invariant(
    renderedLocalEvent.recordingId === scenario.recordingId,
    "rendered local health event recorded the wrong recording",
  );
  invariant(
    renderedLocalEvent.details?.jobId === scenario.jobId,
    "rendered local health event recorded the wrong job",
  );
  invariant(
    renderedLocalEvent.details?.outputCodec === "mp3",
    "rendered local health event did not record MP3 output",
  );
  invariant(
    renderedLocalEvent.details?.outputVbr === true,
    "rendered local health event did not record VBR output",
  );

  if (scenario.expectChannelMapLookupFailure) {
    assertChannelMapLookupFailureScenario({ healthLogEvents, observed, scenario });
  }
}

export function assertControllerTerminalStatusScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  invariant(
    job.status === scenario.controllerTerminalStatus,
    "fake controller did not preserve terminal job status",
  );
  invariant(observed.failures === 0, "agent marked controller-terminal job failed");
  invariant(observed.cancellations === 0, "agent marked controller-terminal job cancelled");
  invariant(!observed.cacheUpload, "agent uploaded cache after controller terminal status");
  invariant(
    state.status === scenario.controllerTerminalStatus,
    "agent state file did not preserve controller terminal status",
  );
  invariant(state.jobId === scenario.jobId, "terminal state recorded the wrong job id");
  invariant(state.outputPath === null, "terminal state unexpectedly recorded an output path");
  invariant(
    state.reason === (scenario.controllerTerminalReason ?? null),
    "terminal state did not preserve controller failure reason",
  );
  invariant(
    !healthLogEvents.some((event) => event.type === "agent.recording_job.output_rendered"),
    "agent rendered output after controller terminal status",
  );
}

function assertChannelMapLookupFailureScenario({ healthLogEvents, observed, scenario }) {
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.channel_map_lookup_failed",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.channel_map_lookup_failed",
  );

  invariant(observed.channelMapFailures === 1, "fake controller did not fail channel-map once");
  invariant(localEvent, "agent local health log did not include channel-map lookup failure");
  invariant(localEvent.severity === "warning", "channel-map lookup failure was not warning");
  invariant(
    localEvent.recordingId === scenario.recordingId,
    "channel-map local health event recorded the wrong recording",
  );
  invariant(syncedEvent, "agent did not sync channel-map lookup failure health event");
  invariant(
    String(syncedEvent.details?.error).includes(
      "controller rejected channel map assignment request with 503",
    ),
    "channel-map health event did not preserve controller rejection",
  );
}

function assertCaptureFailureHealth({
  eventType,
  healthLogEvents,
  job,
  observed,
  reasonFragment,
  scenario,
  state,
}) {
  const localEvent = healthLogEvents.find((event) => event.type === eventType);
  const syncedEvent = observed.healthEvents.find((event) => event.type === eventType);

  invariant(job.status === "failed", "fake controller did not mark capture job failed");
  invariant(observed.failures === 1, "agent did not mark capture job failed");
  invariant(!observed.cacheUpload, "agent uploaded cache after capture failure");
  invariant(state.status === "failed", "capture failure state file did not end failed");
  invariant(state.jobId === scenario.jobId, "capture failure state recorded the wrong job id");
  invariant(
    String(state.reason).includes(reasonFragment),
    "capture failure state did not retain the capture reason",
  );
  invariant(
    String(observed.failureReason).includes(reasonFragment),
    "capture failed-job reason did not include capture failure",
  );
  invariant(localEvent, "agent local health log did not include capture failure");
  invariant(localEvent.severity === "critical", "capture failure was not critical");
  invariant(
    localEvent.recordingId === scenario.recordingId,
    "capture failure local health event recorded the wrong recording",
  );
  invariant(syncedEvent, "agent did not sync capture failure health event");
  invariant(
    String(syncedEvent.details?.error).includes(reasonFragment),
    "capture failure health event did not preserve capture error",
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
