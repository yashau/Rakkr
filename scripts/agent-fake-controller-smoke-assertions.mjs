import { invariant } from "./agent-fake-controller-smoke-utils.mjs";

export function assertStalledCaptureScenario({ healthLogEvents, job, observed, scenario, state }) {
  const stalledLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_output_stalled",
  );
  const syncedEvent = observed.healthEvents.find(
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
    stalledLocalEvent.details?.growthGraceSeconds === 0,
    "stalled capture did not include the configured growth grace",
  );
  invariant(
    stalledLocalEvent.details?.stalledSeconds === scenario.captureStalledSeconds,
    "stalled capture did not include the configured stalled threshold",
  );
  invariant(
    Number.isFinite(stalledLocalEvent.details?.growthAgeSeconds) &&
      stalledLocalEvent.details.growthAgeSeconds >= scenario.captureStalledSeconds,
    "stalled capture did not include finite growth age evidence",
  );
  invariant(
    Number.isFinite(stalledLocalEvent.details?.lastGrowthSecondsAgo) &&
      stalledLocalEvent.details.lastGrowthSecondsAgo >= scenario.captureStalledSeconds,
    "stalled capture did not include finite last-growth evidence",
  );
  invariant(
    stalledLocalEvent.details?.sizeBytes > 0,
    "stalled capture did not include observed output size",
  );
  invariant(syncedEvent, "agent did not sync capture output stall health event");
  invariant(
    syncedEvent.details?.lastGrowthSecondsAgo === stalledLocalEvent.details.lastGrowthSecondsAgo,
    "synced stalled capture health event did not preserve last-growth evidence",
  );
}

export function assertRenderFailureScenario({ healthLogEvents, job, observed, scenario, state }) {
  const renderLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.output_render_failed",
  );
  const syncedEvent = observed.healthEvents.find(
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
    renderLocalEvent.details?.renderCommand,
    "render failure did not include render command evidence",
  );
  invariant(
    renderLocalEvent.details?.rawOutputBytes > 44,
    "render failure did not include raw output byte evidence",
  );
  invariant(
    renderLocalEvent.details?.rawOutputPath?.endsWith(".raw.wav"),
    "render failure did not include raw output path evidence",
  );
  invariant(
    renderLocalEvent.details?.renderedOutputPath?.endsWith(scenario.outputFileName),
    "render failure did not include intended rendered output path",
  );
  invariant(syncedEvent, "agent did not sync render failure health event");
  invariant(
    syncedEvent.details?.renderCommand === renderLocalEvent.details.renderCommand,
    "synced render failure health event did not preserve render command evidence",
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

export function assertCaptureDeviceLostScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  assertCaptureFailureHealth({
    eventType: "agent.recording_job.capture_device_lost",
    healthLogEvents,
    job,
    observed,
    reasonFragment: "Input/output error",
    scenario,
    state,
  });
}

export function assertCaptureRuntimeRecoveryScenario({
  healthLogEvents,
  job,
  observed,
  renderedLocalEvent,
  scenario,
  state,
}) {
  const lostLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_device_lost",
  );
  const lostSyncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.capture_device_lost",
  );
  const restartedLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_runtime_restarted",
  );
  const restartedSyncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.capture_runtime_restarted",
  );
  const stitchedLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_stitched",
  );
  const stitchedSyncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_stitched",
  );

  invariant(job.status === "completed", "runtime capture recovery did not complete the job");
  invariant(observed.failures === 0, "runtime capture recovery should not mark the job failed");
  invariant(observed.cacheUpload, "agent did not upload cache after runtime capture recovery");
  invariant(
    state.status === "completed",
    "runtime capture recovery state file did not end completed",
  );
  invariant(
    state.reason === undefined || state.reason === null,
    "runtime capture recovery should not retain a terminal reason",
  );
  invariant(lostLocalEvent, "agent local health log did not include transient device loss");
  invariant(lostLocalEvent.severity === "warning", "transient device loss was not warning");
  invariant(
    String(lostLocalEvent.details?.error).includes("Input/output error"),
    "transient device loss did not preserve capture stderr",
  );
  invariant(
    lostLocalEvent.details?.willRetry === true,
    "transient device loss did not record retry intent",
  );
  invariant(
    lostLocalEvent.details?.nextAttempt === 2,
    "transient device loss did not record the restart attempt",
  );
  invariant(lostSyncedEvent, "agent did not sync transient device loss health event");
  invariant(
    lostSyncedEvent.details?.willRetry === true,
    "synced transient device loss did not preserve retry intent",
  );
  invariant(restartedLocalEvent, "agent local health log did not include runtime restart");
  invariant(restartedLocalEvent.severity === "info", "runtime restart was not informational");
  invariant(restartedSyncedEvent, "agent did not sync runtime restart health event");
  invariant(stitchedLocalEvent, "agent local health log did not include stitched segments");
  invariant(stitchedLocalEvent.severity === "info", "stitched segments event was not info");
  invariant(stitchedLocalEvent.details?.segmentCount === 1, "stitched event lost segment count");
  invariant(stitchedLocalEvent.details?.gapCount === 1, "stitched event lost gap count");
  invariant(
    stitchedLocalEvent.details?.stitchedBytes > stitchedLocalEvent.details?.segmentBytes,
    "stitched event did not include combined output byte evidence",
  );
  invariant(stitchedSyncedEvent, "agent did not sync stitched segment health event");
  invariant(
    stitchedSyncedEvent.details?.segmentCount === stitchedLocalEvent.details.segmentCount,
    "synced stitched event did not preserve segment count",
  );
  assertRenderedOutputScenario({ healthLogEvents, observed, renderedLocalEvent, scenario });
}

export function assertStitchFailureScenario({ healthLogEvents, job, observed, state }) {
  // GH-1: when recovered pre-loss segments cannot be stitched, the agent must NOT
  // silent-complete on the final segment alone. It fails the job, emits a critical
  // "unrecoverable" event listing the preserved files, and uploads nothing.
  const stitchFailedLocal = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_stitch_failed",
  );
  const unrecoverableLocal = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_unrecoverable",
  );
  const unrecoverableSynced = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_unrecoverable",
  );

  invariant(job.status === "failed", "fake controller did not mark unstitchable job failed");
  invariant(observed.failures === 1, "agent did not mark unstitchable job failed");
  invariant(!observed.cacheUpload, "agent uploaded cache after unstitchable segments (silent complete)");
  invariant(state.status === "failed", "unstitchable state file did not end failed");
  invariant(
    String(state.reason).includes("capture_segments_stitch_failed"),
    "unstitchable state did not retain the stitch-failure reason",
  );
  invariant(
    String(observed.failureReason).includes("capture_segments_stitch_failed"),
    "unstitchable failed-job reason did not include the stitch failure",
  );
  invariant(stitchFailedLocal, "agent local health log did not include capture_segments_stitch_failed");
  invariant(stitchFailedLocal.severity === "warning", "stitch failure event was not warning");
  invariant(unrecoverableLocal, "agent local health log did not include capture_segments_unrecoverable");
  invariant(unrecoverableLocal.severity === "critical", "unrecoverable segments event was not critical");
  invariant(
    Array.isArray(unrecoverableLocal.details?.preservedPaths) &&
      unrecoverableLocal.details.preservedPaths.length >= 2,
    "unrecoverable event did not list the preserved segment + final files",
  );
  invariant(
    Array.isArray(unrecoverableLocal.details?.preservedBytes) &&
      unrecoverableLocal.details.preservedBytes.every((bytes) => Number.isFinite(bytes) && bytes > 0),
    "unrecoverable event did not record that the preserved files are on disk (byte evidence)",
  );
  invariant(unrecoverableSynced, "agent did not sync the unrecoverable segments health event");
  invariant(
    !healthLogEvents.some((event) => event.type === "agent.recording_job.output_rendered"),
    "agent rendered output after an unstitchable recovery",
  );
}

export function assertTinyCaptureFailureScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  assertCaptureFailureHealth({
    eventType: "agent.recording_job.capture_failed",
    healthLogEvents,
    job,
    observed,
    reasonFragment: "capture output is too small",
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

  invariant(job.status === "completed", "status-poll retry did not complete the job");
  invariant(observed.failures === 0, "agent should not mark transient status-poll failure failed");
  invariant(observed.jobStatusReadFailures === 1, "fake controller did not fail status read once");
  invariant(observed.cacheUpload, "agent did not upload cache after status-poll recovery");
  invariant(state.status === "completed", "status-poll recovery state file did not end completed");
  invariant(state.jobId === scenario.jobId, "status-poll state recorded the wrong job id");
  invariant(
    state.reason === undefined || state.reason === null,
    "status-poll recovery should not retain a terminal reason",
  );
  invariant(
    observed.failureReason === undefined,
    "status-poll recovery should not set terminal failure reason",
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

  invariant(job.status === "completed", "control-plane retry did not complete the job");
  invariant(
    observed.failures === 0,
    "agent should not mark transient control-plane failure failed",
  );
  invariant(observed.jobHeartbeatFailures === 1, "fake controller did not fail heartbeat once");
  invariant(observed.cacheUpload, "agent did not upload cache after control-plane recovery");
  invariant(
    state.status === "completed",
    "control-plane recovery state file did not end completed",
  );
  invariant(state.jobId === scenario.jobId, "control-plane state recorded the wrong job id");
  invariant(
    state.reason === undefined || state.reason === null,
    "control-plane recovery should not retain a terminal reason",
  );
  invariant(
    observed.failureReason === undefined,
    "control-plane recovery should not set terminal failure reason",
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

  if (scenario.expectChannelMapApplied) {
    assertChannelMapAppliedScenario({ healthLogEvents, observed, scenario });
  }

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

function assertChannelMapAppliedScenario({ healthLogEvents, observed, scenario }) {
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.channel_map_applied",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.channel_map_applied",
  );

  invariant(observed.channelMapReads === 1, "agent did not read channel-map assignments");
  invariant(localEvent, "agent local health log did not include channel-map application");
  invariant(localEvent.severity === "info", "channel-map application was not informational");
  invariant(
    localEvent.recordingId === scenario.recordingId,
    "channel-map application recorded the wrong recording",
  );
  invariant(
    localEvent.details?.assignmentId === scenario.expectedChannelMap.assignmentId,
    "channel-map application recorded the wrong assignment",
  );
  invariant(
    localEvent.details?.templateId === scenario.expectedChannelMap.templateId,
    "channel-map application recorded the wrong template",
  );
  invariant(
    localEvent.details?.captureChannels === scenario.expectedChannelMap.captureChannels,
    "channel-map application did not preserve capture channel count",
  );
  invariant(
    localEvent.details?.channelMode === scenario.expectedChannelMap.channelMode,
    "channel-map application recorded the wrong channel mode",
  );
  invariant(
    localEvent.details?.entryCount === scenario.expectedChannelMap.entryCount,
    "channel-map application recorded the wrong entry count",
  );
  invariant(syncedEvent, "agent did not sync channel-map application health event");
  invariant(
    syncedEvent.details?.assignmentId === localEvent.details.assignmentId,
    "synced channel-map application did not preserve assignment evidence",
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
  const localEvent = healthLogEvents.find(
    (event) => event.type === eventType && event.severity === "critical",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === eventType && event.severity === "critical",
  );

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
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.cache_upload_failed",
  );

  invariant(job.status === "running", "cache upload failure should leave job retryable");
  invariant(observed.failures === 0, "agent should not mark cache upload failure job failed");
  invariant(
    observed.failureReason === undefined,
    "cache upload failure should not set terminal failure reason",
  );
  invariant(
    state.status === "upload_pending",
    "agent state file did not retain upload-pending retry state",
  );
  invariant(state.jobId === scenario.jobId, "upload-pending state file recorded the wrong job id");
  invariant(
    state.outputPath?.endsWith(scenario.outputFileName),
    "upload-pending state did not retain rendered output path",
  );
  invariant(
    String(state.reason).includes("controller rejected cache file with 503"),
    "upload-pending state did not retain cache upload rejection reason",
  );
  invariant(syncedEvent, "agent did not report cache upload failure");
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
  invariant(
    failedLocalEvent.details?.contentType === "audio/mpeg",
    "cache upload failure did not include content type evidence",
  );
  invariant(
    failedLocalEvent.details?.durationSeconds === 1,
    "cache upload failure did not include duration evidence",
  );
  invariant(
    failedLocalEvent.details?.fileName === scenario.outputFileName,
    "cache upload failure did not include file name evidence",
  );
  invariant(
    failedLocalEvent.details?.outputBytes > 44,
    "cache upload failure did not include output byte evidence",
  );
  invariant(
    failedLocalEvent.details?.outputCodec === "mp3",
    "cache upload failure did not include output codec evidence",
  );
  invariant(
    failedLocalEvent.details?.outputPath?.endsWith(scenario.outputFileName),
    "cache upload failure did not include output path evidence",
  );
  invariant(
    syncedEvent.details?.outputBytes === failedLocalEvent.details.outputBytes,
    "synced cache upload failure did not preserve output byte evidence",
  );
}

export function assertRecorderCacheTrackFailureScenario({
  healthLogEvents,
  job,
  observed,
  scenario,
  state,
}) {
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.recorder_cache_track_failed",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.recorder_cache_track_failed",
  );

  invariant(job.status === "completed", "track-failure job did not complete");
  invariant(state.status === "completed", "track-failure state file did not end completed");
  invariant(state.jobId === scenario.jobId, "track-failure state recorded the wrong job id");
  invariant(
    observed.cacheUpload?.recordingId === scenario.recordingId,
    "track-failure job did not upload cache",
  );
  invariant(localEvent, "agent local health log did not include recorder-cache track failure");
  invariant(localEvent.severity === "warning", "recorder-cache track failure was not warning");
  invariant(
    localEvent.recordingId === scenario.recordingId,
    "track failure recorded the wrong recording",
  );
  invariant(
    localEvent.details?.policyId === scenario.recorderCacheRetention.policyId,
    "track failure recorded wrong policy",
  );
  invariant(syncedEvent, "agent did not sync recorder-cache track failure health event");
  invariant(
    String(syncedEvent.details?.error).includes("recorder cache manifest"),
    "recorder-cache track failure did not preserve manifest error",
  );
}
