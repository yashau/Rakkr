import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnDaemonAgent } from "./agent-fake-controller-smoke-agent.mjs";
import {
  writeDeviceAssertCaptureCommand,
  writeRenumberedAudioInventoryFixtures,
  writeRecoverableRestartCaptureFile,
} from "./agent-fake-controller-smoke-support.mjs";
import {
  fileExists,
  invariant,
  readJsonLines,
  waitFor,
} from "./agent-fake-controller-smoke-utils.mjs";

export async function runUploadBoundaryRecoveryScenarios(deps) {
  await runUploadPendingRecoveryScenario(deps);
  await runUploadedRecoveryScenario(deps);
  await runDiskPreflightRecoveryScenario(deps);
  await runCaptureDeviceRenumberingScenario(deps);
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

async function runDiskPreflightRecoveryScenario({
  address,
  agentContext,
  captureCommand,
  createJob,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
}) {
  const stateFile = path.join(smokeRoot, "disk-preflight-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "disk-preflight-recovery-health-events.jsonl");
  const manifestFile = path.join(smokeRoot, "disk-preflight-recovery-manifest.json");
  const cacheRoot = path.join(smokeRoot, "data", "recordings", "local-captures");
  const staleRawPath = path.join(cacheRoot, "rec_fake_controller_stale.raw.wav");
  const staleOutputPath = path.join(cacheRoot, "rec_fake_controller_stale.mp3");
  const fakeDfPath = await writeDiskPreflightDfCommand(smokeRoot);
  const retention = {
    deleteAfterUpload: false,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: 95,
    policyId: "retention-disk-preflight-recovery-smoke",
  };
  const job = createJob({
    captureChannels: 4,
    durationSeconds: 2,
    expectSuccess: true,
    jobId: "job_fake_controller_disk_preflight_recovery",
    name: "disk-preflight-recovery",
    outputFileName: "rec_fake_controller_disk_preflight_recovery.mp3",
    recordingId: "rec_fake_controller_disk_preflight_recovery",
    recorderCacheRetention: retention,
  });
  const observed = createObserved();

  await mkdir(cacheRoot, { recursive: true });
  await writeFile(staleRawPath, Buffer.alloc(128, 1));
  await writeFile(staleOutputPath, Buffer.alloc(256, 2));
  await writeFile(
    manifestFile,
    JSON.stringify(
      {
        entries: [
          {
            outputPath: staleOutputPath,
            policyId: retention.policyId,
            rawOutputPath: staleRawPath,
            recordingId: "rec_fake_controller_stale",
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );

  setActiveScenario({
    job,
    jobs: [job],
    observed,
    scenario: {
      expectSuccess: true,
      name: "disk-preflight-recovery",
      recorderCachePolicySequence: [[], [retention]],
    },
  });

  const child = spawnDaemonAgent(
    agentContext,
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
    {
      PATH: `${fakeDfPath}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    [
      "--recorder-cache-manifest-file",
      manifestFile,
      "--system-health-df-command",
      fakeDfCommandPath(fakeDfPath),
    ],
  );

  try {
    await waitFor(
      () =>
        job.status === "completed" &&
        observed.cacheUpload &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.disk_space_recovered",
        ),
      30_000,
      () =>
        `job=${job.status} upload=${Boolean(observed.cacheUpload)} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const healthLogEvents = await readJsonLines(healthLogFile);
  const cleanupEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.disk_space_cleanup_attempted",
  );
  const recoveredEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.disk_space_recovered",
  );

  invariant(job.status === "completed", "disk preflight recovery did not complete the job");
  invariant(state.status === "completed", "disk preflight recovery state did not complete");
  invariant(observed.cacheUploads.length === 1, "disk preflight recovery did not upload once");
  invariant(cleanupEvent?.details?.deleted === 1, "disk preflight cleanup did not delete cache");
  invariant(
    cleanupEvent.details?.items?.[0]?.reason === "min_free_disk",
    "disk preflight cleanup did not use min-free policy",
  );
  invariant(
    recoveredEvent?.details?.freeBytes > recoveredEvent?.details?.initialFreeBytes,
    "disk preflight recovery did not record improved free space",
  );
  invariant(!(await fileExists(staleRawPath)), "disk preflight cleanup left stale raw cache");
  invariant(!(await fileExists(staleOutputPath)), "disk preflight cleanup left stale output cache");
  setActiveScenario(undefined);
}

async function runCaptureDeviceRenumberingScenario({
  address,
  agentContext,
  createJob,
  createObserved,
  renderCommand,
  setActiveScenario,
  smokeRoot,
}) {
  const stateFile = path.join(smokeRoot, "capture-device-renumbering-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "capture-device-renumbering-health-events.jsonl");
  const captureCommand = await writeDeviceAssertCaptureCommand(
    smokeRoot,
    "hw:CARD=SMOKE,DEV=0",
  );
  const inventory = await writeRenumberedAudioInventoryFixtures(smokeRoot);
  const job = createJob({
    captureInterfaceId: "alsa_card_smoke_dev_0",
    expectSuccess: true,
    jobId: "job_fake_controller_capture_device_renumbering",
    name: "capture-device-renumbering",
    outputFileName: "rec_fake_controller_capture_device_renumbering.mp3",
    recordingId: "rec_fake_controller_capture_device_renumbering",
  });
  const observed = createObserved();
  job.command.captureDevice = "hw:2,0";
  setActiveScenario({
    job,
    jobs: [job],
    observed,
    scenario: {
      expectSuccess: true,
      name: "capture-device-renumbering",
    },
  });

  const child = spawnDaemonAgent(
    agentContext,
    address,
    captureCommand,
    healthLogFile,
    renderCommand,
    stateFile,
    {
      PATH: `${inventory.fakeArecordPath}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    [
      "--inventory-arecord-command",
      inventory.fakeArecordCommand,
      "--inventory-proc-asound-pcm-path",
      inventory.fakeProcAsoundPcmPath,
    ],
  );

  try {
    await waitFor(
      () =>
        job.status === "completed" &&
        observed.cacheUpload &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.capture_device_refreshed",
        ) &&
        agentStateStatus(stateFile) === "completed",
      30_000,
      () =>
        `job=${job.status} upload=${Boolean(observed.cacheUpload)} state=${agentStateStatus(stateFile) ?? "<missing>"} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const healthLogEvents = await readJsonLines(healthLogFile);
  const refreshEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_device_refreshed",
  );

  invariant(job.status === "completed", "capture device renumbering did not complete the job");
  invariant(state.status === "completed", "capture device renumbering state did not complete");
  invariant(observed.cacheUploads.length === 1, "capture device renumbering did not upload once");
  invariant(refreshEvent, "capture device renumbering did not log refresh");
  invariant(
    refreshEvent.details?.captureInterfaceId === "alsa_card_smoke_dev_0",
    "capture device renumbering used the wrong stable interface id",
  );
  invariant(
    refreshEvent.details?.previousDevice === "hw:2,0",
    "capture device renumbering did not record the stale device",
  );
  invariant(
    refreshEvent.details?.refreshedDevice === "hw:CARD=SMOKE,DEV=0",
    "capture device renumbering did not record the refreshed device",
  );
  setActiveScenario(undefined);
}

function agentStateStatus(stateFile) {
  if (!existsSync(stateFile)) {
    return undefined;
  }

  return JSON.parse(readFileSync(stateFile, "utf8")).status;
}

async function writeAgentState(stateFile, state) {
  await writeFile(
    stateFile,
    JSON.stringify({ ...state, updatedAt: "2026-06-25T00:00:00Z" }, null, 2),
  );
}

function fakeDfCommandPath(fakeDfPath) {
  return path.join(fakeDfPath, process.platform === "win32" ? "df.cmd" : "df");
}

async function writeDiskPreflightDfCommand(directory) {
  const fakeBin = path.join(directory, "fake-disk-preflight-bin");
  const dfScript = path.join(fakeBin, "df");
  const stateFile = path.join(directory, "fake-disk-preflight-df-state.txt");

  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    dfScript,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = ${JSON.stringify(stateFile)};
const previousRuns = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8")) : 0;
writeFileSync(stateFile, String(previousRuns + 1));

console.log("Filesystem 1024-blocks Used Available Capacity Mounted on");
if (previousRuns < 2) {
  console.log("rakkr-smoke 1000 900 100 90% /");
} else {
  console.log("rakkr-smoke 1000 100 900 10% /");
}
`,
  );

  if (process.platform === "win32") {
    await writeFile(
      path.join(fakeBin, "df.cmd"),
      `@echo off\r\n"${process.execPath}" "${dfScript}" %*\r\n`,
    );
  } else {
    await chmod(dfScript, 0o755);
  }

  return fakeBin;
}
