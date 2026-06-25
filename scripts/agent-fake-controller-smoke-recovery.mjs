import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnDaemonAgent } from "./agent-fake-controller-smoke-agent.mjs";
import { writeRecoverableRestartCaptureFile } from "./agent-fake-controller-smoke-support.mjs";
import { invariant, readJsonLines, waitFor } from "./agent-fake-controller-smoke-utils.mjs";

export async function runUploadBoundaryRecoveryScenarios(deps) {
  await runUploadPendingRecoveryScenario(deps);
  await runUploadedRecoveryScenario(deps);
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
