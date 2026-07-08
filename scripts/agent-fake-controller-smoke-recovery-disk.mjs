import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnDaemonAgent } from "./agent-fake-controller-smoke-agent.mjs";
import {
  writeDeviceAssertCaptureCommand,
  writeRenumberedAudioInventoryFixtures,
} from "./agent-fake-controller-smoke-support.mjs";
import { fileExists, invariant, readJsonLines, waitFor } from "./agent-fake-controller-smoke-utils.mjs";

export async function runDiskPreflightRecoveryScenario({
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

export async function runRuntimeDiskRecoveryScenario({
  address,
  agentContext,
  captureCommand,
  createJob,
  createObserved,
  nodeId: _nodeId,
  renderCommand,
  setActiveScenario,
  smokeRoot,
}) {
  const stateFile = path.join(smokeRoot, "runtime-disk-recovery-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "runtime-disk-recovery-health-events.jsonl");
  const manifestFile = path.join(smokeRoot, "runtime-disk-recovery-manifest.json");
  const cacheRoot = path.join(smokeRoot, "data", "recordings", "local-captures");
  const rawCapturePath = path.join(
    cacheRoot,
    "rec_fake_controller_runtime_disk_recovery.raw.wav",
  );
  const staleRawPath = path.join(cacheRoot, "rec_fake_controller_runtime_stale.raw.wav");
  const staleOutputPath = path.join(cacheRoot, "rec_fake_controller_runtime_stale.mp3");
  const fakeDfPath = await writeRuntimeDiskRecoveryDfCommand(
    smokeRoot,
    rawCapturePath,
    staleOutputPath,
  );
  const retention = {
    deleteAfterUpload: false,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: 95,
    policyId: "retention-runtime-disk-recovery-smoke",
  };
  const job = createJob({
    durationSeconds: 2,
    expectSuccess: true,
    jobId: "job_fake_controller_runtime_disk_recovery",
    name: "runtime-disk-recovery",
    outputFileName: "rec_fake_controller_runtime_disk_recovery.mp3",
    recordingId: "rec_fake_controller_runtime_disk_recovery",
    recorderCacheRetention: retention,
  });
  const observed = createObserved();

  await mkdir(cacheRoot, { recursive: true });
  await writeFile(staleRawPath, Buffer.alloc(128, 3));
  await writeFile(staleOutputPath, Buffer.alloc(256, 4));
  await writeFile(
    manifestFile,
    JSON.stringify(
      {
        entries: [
          {
            outputPath: staleOutputPath,
            policyId: retention.policyId,
            rawOutputPath: staleRawPath,
            recordingId: "rec_fake_controller_runtime_stale",
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
      name: "runtime-disk-recovery",
      recorderCachePolicies: [retention],
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
          (event) => event.type === "agent.recording_job.disk_space_runtime_recovered",
        ) &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recording_job.capture_segments_stitched",
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
  const exhaustedEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.disk_space_exhausted",
  );
  const runtimeRecoveredEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.disk_space_runtime_recovered",
  );
  const stitchedEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.capture_segments_stitched",
  );

  invariant(job.status === "completed", "runtime disk recovery did not complete the job");
  invariant(state.status === "completed", "runtime disk recovery state did not complete");
  invariant(observed.failures === 0, "runtime disk recovery should not mark the job failed");
  invariant(observed.cacheUploads.length === 1, "runtime disk recovery did not upload once");
  invariant(exhaustedEvent, "runtime disk recovery did not log disk exhaustion");
  invariant(
    exhaustedEvent.severity === "warning",
    "recoverable runtime disk exhaustion was not warning severity",
  );
  invariant(
    exhaustedEvent.details?.willRetry === true,
    "runtime disk exhaustion did not record retry intent",
  );
  invariant(runtimeRecoveredEvent, "runtime disk recovery did not log recovery");
  invariant(
    runtimeRecoveredEvent.details?.requiredBytes >= runtimeRecoveredEvent.details?.remainingBytes,
    "runtime disk recovery did not preserve required byte evidence",
  );
  invariant(stitchedEvent, "runtime disk recovery did not stitch the preserved segment");
  invariant(stitchedEvent.details?.segmentCount === 1, "runtime disk recovery lost segment count");
  invariant(!(await fileExists(staleRawPath)), "runtime disk cleanup left stale raw cache");
  invariant(!(await fileExists(staleOutputPath)), "runtime disk cleanup left stale output cache");
  setActiveScenario(undefined);
}

export async function runCaptureDeviceRenumberingScenario({
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

export function agentStateStatus(stateFile) {
  if (!existsSync(stateFile)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(stateFile, "utf8")).status;
  } catch {
    return undefined;
  }
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

async function writeRuntimeDiskRecoveryDfCommand(directory, rawCapturePath, staleCachePath) {
  const fakeBin = path.join(directory, "fake-runtime-disk-recovery-bin");
  const dfScript = path.join(fakeBin, "df");

  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    dfScript,
    `#!/usr/bin/env node
import { existsSync } from "node:fs";

const rawCapturePath = ${JSON.stringify(rawCapturePath)};
const staleCachePath = ${JSON.stringify(staleCachePath)};

// Report the disk as full only while a capture is in flight (the raw capture
// file exists) and the stale cache entry has not yet been swept away. Keying the
// low reading to filesystem state -- rather than a one-shot counter -- keeps the
// system-health monitor and the recording-job disk monitor observing the same
// condition, so the runtime disk-recovery path fires deterministically no matter
// which loop polls df first. The reading flips back to healthy the moment the
// recovery sweep deletes the stale cache files.
console.log("Filesystem 1024-blocks Used Available Capacity Mounted on");
if (existsSync(rawCapturePath) && existsSync(staleCachePath)) {
  console.log("rakkr-smoke 10000 9999 1 99% /");
} else {
  console.log("rakkr-smoke 10000 100 9900 1% /");
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
