import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnDaemonAgent } from "./agent-fake-controller-smoke-agent.mjs";
import {
  agentStateStatus,
  runCaptureDeviceRenumberingScenario,
  runDiskPreflightRecoveryScenario,
  runRuntimeDiskRecoveryScenario,
} from "./agent-fake-controller-smoke-recovery-disk.mjs";
import { writeRecoverableRestartCaptureFile } from "./agent-fake-controller-smoke-support.mjs";
import { fileExists, invariant, readJsonLines, waitFor } from "./agent-fake-controller-smoke-utils.mjs";

export async function runUploadBoundaryRecoveryScenarios(deps) {
  await runRestartRecoveryScenario(deps);
  await runPowerLossTinyPartialRecoveryScenario(deps);
  await runUploadPendingRecoveryScenario(deps);
  await runUploadedRecoveryScenario(deps);
  await runDiskPreflightRecoveryScenario(deps);
  await runRuntimeDiskRecoveryScenario(deps);
  await runCaptureDeviceRenumberingScenario(deps);
}

async function runRestartRecoveryScenario({
  address,
  agentContext,
  captureCommand,
  createJob,
  createObserved,
  nodeId,
  renderCommand,
  setActiveScenario,
  smokeRoot,
}) {
  const stateFile = path.join(smokeRoot, "restart-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "restart-recovery-health-events.jsonl");
  const outputPath = await writeRecoverableRestartCaptureFile(
    smokeRoot,
    "rec_fake_controller_restart_recovery.raw.wav",
  );
  const segmentPath = await writeRecoverableRestartCaptureFile(
    smokeRoot,
    "rec_fake_controller_restart_recovery.raw.recovery-attempt-1.wav",
  );
  const segmentBytes = (await readFile(segmentPath)).byteLength;
  const job = createJob({
    expectSuccess: true,
    jobId: "job_fake_controller_restart_recovery",
    name: "restart-recovery",
    outputFileName: "rec_fake_controller_restart_recovery.mp3",
    recordingId: "rec_fake_controller_restart_recovery",
  });
  const observed = createObserved();
  job.status = "running";
  setActiveScenario({
    job,
    jobs: [job],
    observed,
    scenario: { expectSuccess: true, name: "restart-recovery" },
  });
  await writeFile(
    stateFile,
    JSON.stringify(
      {
        jobId: job.id,
        nodeId,
        outputPath,
        reason: null,
        recordingId: job.recordingId,
        recoveredSegments: [
          {
            attempt: 1,
            bytes: segmentBytes,
            path: segmentPath,
            reason: "capture command arecord failed with status exit code: 32",
          },
        ],
        status: "running",
        updatedAt: "2026-06-25T00:00:00Z",
      },
      null,
      2,
    ),
  );

  const child = spawnDaemonAgent(
    agentContext,
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
  );

  try {
    await waitFor(
      () =>
        job.status === "completed" &&
        observed.cacheUpload &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.recovered_after_restart",
        ),
      20_000,
      () =>
        `job=${job.status} upload=${Boolean(observed.cacheUpload)} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const healthLogEvents = await readJsonLines(healthLogFile);
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.recovered_after_restart",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.recovered_after_restart",
  );

  invariant(observed.claims === 0, "restart recovery should not claim a fresh job");
  invariant(
    observed.cacheUpload?.recordingId === job.recordingId,
    "restart recovery upload target",
  );
  invariant(observed.cacheUpload?.contentType === "audio/wav", "restart recovery uploaded raw WAV");
  invariant(state.status === "completed", "restart recovery state did not complete");
  invariant(localEvent, "restart recovery did not write local health");
  invariant(
    localEvent.details?.willUpload === true,
    "restart recovery did not record upload intent",
  );
  invariant(
    localEvent.details?.recoveredSegmentCount === 1,
    "restart recovery did not retain recovered segment evidence",
  );
  invariant(syncedEvent, "restart recovery did not sync health event");
  invariant(
    syncedEvent.details?.recoveredSegmentCount === 1,
    "synced restart recovery lost segment evidence",
  );

  // RS1: the pre-loss segment must be stitched with the final segment before upload,
  // not dropped. Before the fix the agent uploaded only the final segment and left
  // the recovered segment untouched (and leaked).
  const stitchedLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_stitched",
  );
  const stitchedSyncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_stitched",
  );
  invariant(
    localEvent.details?.stitchedRecoveredSegments === true,
    "restart recovery did not stitch the recovered segments before upload",
  );
  invariant(stitchedLocalEvent, "restart recovery did not log stitched segments");
  invariant(stitchedSyncedEvent, "restart recovery did not sync the stitched segments event");
  invariant(
    !(await fileExists(segmentPath)),
    "restart recovery did not consume the recovered segment (leak)",
  );
  setActiveScenario(undefined);
}

async function runPowerLossTinyPartialRecoveryScenario({
  address,
  agentContext,
  captureCommand,
  createJob,
  createObserved,
  nodeId,
  renderCommand,
  setActiveScenario,
  smokeRoot,
}) {
  const stateFile = path.join(smokeRoot, "power-loss-tiny-partial-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "power-loss-tiny-partial-health-events.jsonl");
  const outputPath = path.join(
    smokeRoot,
    "data",
    "recordings",
    "local-captures",
    "rec_fake_controller_power_loss_tiny_partial.raw.wav",
  );
  const job = createJob({
    expectSuccess: false,
    jobId: "job_fake_controller_power_loss_tiny_partial",
    name: "power-loss-tiny-partial",
    outputFileName: "rec_fake_controller_power_loss_tiny_partial.mp3",
    recordingId: "rec_fake_controller_power_loss_tiny_partial",
  });
  const observed = createObserved();
  job.status = "running";

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from("tiny"));
  await writeAgentState(stateFile, {
    jobId: job.id,
    nodeId,
    outputPath,
    reason: null,
    recordingId: job.recordingId,
    status: "running",
  });
  setActiveScenario({
    job,
    jobs: [job],
    observed,
    scenario: { expectSuccess: false, name: "power-loss-tiny-partial" },
  });

  const child = spawnDaemonAgent(
    agentContext,
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
  );

  try {
    await waitFor(
      () =>
        job.status === "failed" &&
        observed.failures === 1 &&
        !observed.cacheUpload &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.recovered_after_restart",
        ) &&
        agentStateStatus(stateFile) === "failed",
      30_000,
      () =>
        `job=${job.status} failures=${observed.failures} upload=${Boolean(observed.cacheUpload)} state=${agentStateStatus(stateFile) ?? "<missing>"} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const healthLogEvents = await readJsonLines(healthLogFile);
  const recoveryEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.recovered_after_restart",
  );
  const syncedEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recording_job.recovered_after_restart",
  );

  invariant(job.status === "failed", "power-loss tiny partial did not fail the job");
  invariant(observed.failures === 1, "power-loss tiny partial did not mark controller failed");
  invariant(!observed.cacheUpload, "power-loss tiny partial uploaded invalid cache");
  invariant(state.status === "failed", "power-loss tiny partial state did not fail");
  invariant(
    state.reason === "agent_restarted_during_recording",
    "power-loss tiny partial did not preserve restart failure reason",
  );
  invariant(recoveryEvent, "power-loss tiny partial did not log restart recovery");
  invariant(
    recoveryEvent.details?.outputBytes === 4,
    "power-loss tiny partial did not preserve tiny output byte evidence",
  );
  invariant(
    recoveryEvent.details?.previousStatus === "running",
    "power-loss tiny partial did not preserve previous state",
  );
  invariant(
    String(observed.failureReason).includes("agent_restarted_during_recording"),
    "power-loss tiny partial did not send restart failure reason",
  );
  invariant(syncedEvent, "power-loss tiny partial did not sync restart recovery");
  setActiveScenario(undefined);
}

async function runUploadPendingRecoveryScenario({
  address,
  agentContext,
  captureCommand,
  createJob,
  createObserved,
  nodeId,
  renderCommand,
  setActiveScenario,
  smokeRoot,
}) {
  const stateFile = path.join(smokeRoot, "upload-pending-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "upload-pending-recovery-health-events.jsonl");
  const rawOutputPath = await writeRecoverableRestartCaptureFile(
    smokeRoot,
    "rec_fake_controller_upload_pending.raw.wav",
  );
  const outputPath = await writeRecoverableRestartCaptureFile(
    smokeRoot,
    "rec_fake_controller_upload_pending.mp3",
  );
  const job = createJob({
    expectSuccess: true,
    jobId: "job_fake_controller_upload_pending",
    name: "upload-pending-recovery",
    outputFileName: "rec_fake_controller_upload_pending.mp3",
    recordingId: "rec_fake_controller_upload_pending",
    recorderCacheRetention: null,
  });
  const observed = createObserved();
  job.status = "running";
  setActiveScenario({
    job,
    jobs: [job],
    observed,
    scenario: { expectSuccess: true, name: "upload-pending-recovery" },
  });
  await writeAgentState(stateFile, {
    jobId: job.id,
    nodeId,
    outputPath,
    rawOutputPath,
    reason: "send cache file to controller",
    recordingId: job.recordingId,
    status: "upload_pending",
    uploadContentType: "audio/mpeg",
    uploadDurationSeconds: 1,
    uploadFileName: job.command.outputFileName,
  });

  const child = spawnDaemonAgent(
    agentContext,
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
  );

  try {
    await waitFor(
      () =>
        job.status === "completed" &&
        observed.cacheUpload &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.recovered_after_restart",
        ),
      20_000,
      () =>
        `job=${job.status} upload=${Boolean(observed.cacheUpload)} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const healthLogEvents = await readJsonLines(healthLogFile);
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.recovered_after_restart",
  );

  invariant(observed.claims === 0, "upload-pending recovery claimed a fresh job");
  invariant(observed.cacheUploads.length === 1, "upload-pending recovery did not upload once");
  invariant(observed.cacheUpload?.contentType === "audio/mpeg", "upload retry lost content type");
  invariant(observed.cacheUpload?.durationSeconds === "1", "upload retry lost duration");
  invariant(
    observed.cacheUpload?.fileName === job.command.outputFileName,
    "upload retry lost file name",
  );
  invariant(state.status === "completed", "upload-pending recovery state did not complete");
  invariant(localEvent?.details?.willUpload === true, "upload-pending recovery did not retry");
  setActiveScenario(undefined);
}

async function runUploadedRecoveryScenario({
  address,
  agentContext,
  captureCommand,
  createJob,
  createObserved,
  nodeId,
  renderCommand,
  setActiveScenario,
  smokeRoot,
}) {
  const stateFile = path.join(smokeRoot, "uploaded-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "uploaded-recovery-health-events.jsonl");
  const rawOutputPath = await writeRecoverableRestartCaptureFile(
    smokeRoot,
    "rec_fake_controller_uploaded.raw.wav",
  );
  const outputPath = await writeRecoverableRestartCaptureFile(
    smokeRoot,
    "rec_fake_controller_uploaded.mp3",
  );
  const retention = {
    deleteAfterUpload: true,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: null,
    policyId: "retention-uploaded-recovery-smoke",
  };
  const job = createJob({
    expectSuccess: true,
    jobId: "job_fake_controller_uploaded",
    name: "uploaded-recovery",
    outputFileName: "rec_fake_controller_uploaded.mp3",
    recordingId: "rec_fake_controller_uploaded",
    recorderCacheRetention: retention,
  });
  const observed = createObserved();
  job.status = "completed";
  setActiveScenario({
    job,
    jobs: [job],
    observed,
    scenario: { expectSuccess: true, name: "uploaded-recovery" },
  });
  await writeAgentState(stateFile, {
    jobId: job.id,
    nodeId,
    outputPath,
    rawOutputPath,
    reason: null,
    recorderCacheRetention: retention,
    recordingId: job.recordingId,
    status: "uploaded",
    uploadContentType: "audio/mpeg",
    uploadDurationSeconds: 1,
    uploadFileName: job.command.outputFileName,
  });

  const child = spawnDaemonAgent(
    agentContext,
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
  );

  try {
    await waitFor(
      () =>
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.recovered_after_restart",
        ) &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.recorder_cache_deleted",
        ),
      20_000,
      () => `health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const healthLogEvents = await readJsonLines(healthLogFile);
  const localEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.recovered_after_restart",
  );
  const retentionEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.recorder_cache_deleted",
  );

  invariant(observed.claims === 0, "uploaded recovery claimed a fresh job");
  invariant(observed.cacheUploads.length === 0, "uploaded recovery re-uploaded cache");
  invariant(state.status === "completed", "uploaded recovery state did not complete");
  invariant(localEvent?.details?.willUpload === false, "uploaded recovery planned an upload");
  invariant(
    localEvent?.details?.uploadAlreadyAccepted === true,
    "uploaded recovery did not record accepted upload",
  );
  invariant(retentionEvent, "uploaded recovery did not resume cache retention");
  invariant(
    retentionEvent.details?.recoveredAfterRestart === true,
    "uploaded recovery retention event did not mark recovery",
  );
  setActiveScenario(undefined);
}

async function writeAgentState(stateFile, state) {
  await writeFile(
    stateFile,
    JSON.stringify({ ...state, updatedAt: "2026-06-25T00:00:00Z" }, null, 2),
  );
}
