#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeFakeCaptureCommand,
  writeFakeDfCommand,
  writeFakeDeviceUnavailableMeterCommand,
  writeFakeFailingRenderCommand,
  writeFakeRecoveringMeterCommand,
  writeFakeRenderCommand,
  writeFakeStalledCaptureCommand,
  writeFakeTemplateCaptureCommand,
  writeFakeTemplateMeterCommand,
  writeFakeXrunMeterCommand,
} from "./agent-fake-controller-smoke-support.mjs";
import {
  assertCacheUploadFailureScenario,
  assertRenderFailureScenario,
  assertStalledCaptureScenario,
} from "./agent-fake-controller-smoke-assertions.mjs";
import { spawnDaemonAgent } from "./agent-fake-controller-smoke-agent.mjs";
import { runTemplateMeterScenario } from "./agent-fake-controller-smoke-devices.mjs";
import {
  runMeterDeviceUnavailableScenario,
  runMeterRecoveryScenario,
  runMeterXrunScenario,
  runMonitorChunkRecoveryScenario,
  runSystemHealthScenario,
} from "./agent-fake-controller-smoke-health.mjs";
import {
  empty,
  fileExists,
  invariant,
  json,
  listen,
  localRecorderCachePaths,
  readBody,
  readJsonLines,
  run,
  waitFor,
} from "./agent-fake-controller-smoke-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const smokeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-fake-controller-"));
const nodeId = "node_fake_controller_smoke";
const token = "node-token";
const agentContext = { nodeId, repoRoot, smokeRoot, token };
const scenarios = [
  {
    cacheUploadFails: false,
    expectSuccess: true,
    jobId: "job_fake_controller_smoke",
    name: "completed",
    outputFileName: "rec_fake_controller_smoke.mp3",
    recordingId: "rec_fake_controller_smoke",
  },
  {
    cacheUploadFails: true,
    expectSuccess: false,
    jobId: "job_fake_controller_cache_upload_failure",
    name: "cache-upload-failure",
    outputFileName: "rec_fake_controller_cache_upload_failure.mp3",
    recordingId: "rec_fake_controller_cache_upload_failure",
  },
  {
    controllerStopRequested: true,
    expectSuccess: true,
    jobId: "job_fake_controller_stop_requested",
    name: "controller-stop-requested",
    outputFileName: "rec_fake_controller_stop_requested.mp3",
    recordingId: "rec_fake_controller_stop_requested",
  },
];
let activeScenario;

const server = createServer(async (request, response) => {
  try {
    await handleControllerRequest(request, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.stack : String(error));
  }
});

try {
  const address = await listen(server);
  const captureCommand = await writeFakeCaptureCommand(smokeRoot);
  const stalledCaptureCommand = await writeFakeStalledCaptureCommand(smokeRoot);
  const templateCaptureCommand = await writeFakeTemplateCaptureCommand(smokeRoot);
  const templateMeterCommand = await writeFakeTemplateMeterCommand(smokeRoot);
  const deviceUnavailableMeterCommand = await writeFakeDeviceUnavailableMeterCommand(smokeRoot);
  const recoveringMeterCommand = await writeFakeRecoveringMeterCommand(smokeRoot);
  const xrunMeterCommand = await writeFakeXrunMeterCommand(smokeRoot);
  const fakeDfPath = await writeFakeDfCommand(smokeRoot);
  const failingRenderCommand = await writeFakeFailingRenderCommand(smokeRoot);
  const renderCommand = await writeFakeRenderCommand(smokeRoot);
  for (const scenario of scenarios) {
    await runScenario({ address, captureCommand, renderCommand, scenario });
  }
  await runScenario({
    address,
    captureCommand: templateCaptureCommand,
    renderCommand,
    scenario: {
      captureArgsTemplate:
        "--template-mode --write-output {output} --device {device} --rate {sample_rate} --channels {channels} --duration {seconds}",
      expectSuccess: true,
      jobId: "job_fake_controller_template_capture",
      name: "template-capture",
      outputFileName: "rec_fake_controller_template_capture.mp3",
      recordingId: "rec_fake_controller_template_capture",
    },
  });
  await runTemplateMeterScenario(
    healthScenarioDeps({ address, renderCommand, templateMeterCommand }),
  );
  await runScenario({
    address,
    captureCommand: stalledCaptureCommand,
    renderCommand,
    scenario: {
      captureStalledSeconds: 1,
      expectStalledCapture: true,
      expectSuccess: false,
      jobId: "job_fake_controller_stalled_capture",
      name: "stalled-capture",
      outputFileName: "rec_fake_controller_stalled_capture.mp3",
      recordingId: "rec_fake_controller_stalled_capture",
    },
  });
  await runScenario({
    address,
    captureCommand,
    renderCommand: failingRenderCommand,
    scenario: {
      expectRenderFailure: true,
      expectSuccess: false,
      jobId: "job_fake_controller_render_failure",
      name: "render-failure",
      outputFileName: "rec_fake_controller_render_failure.mp3",
      recordingId: "rec_fake_controller_render_failure",
    },
  });
  await runConcurrentScenario({ address, captureCommand, renderCommand });
  await runDeferredSweepScenario({ address, captureCommand, renderCommand });
  await runMinFreeSweepScenario({ address, captureCommand, fakeDfPath, renderCommand });
  await runSystemHealthScenario(
    healthScenarioDeps({ address, captureCommand, fakeDfPath, renderCommand }),
  );
  await runMeterXrunScenario(healthScenarioDeps({ address, renderCommand, xrunMeterCommand }));
  await runMeterDeviceUnavailableScenario(
    healthScenarioDeps({ address, deviceUnavailableMeterCommand, renderCommand }),
  );
  await runMeterRecoveryScenario(
    healthScenarioDeps({ address, recoveringMeterCommand, renderCommand }),
  );
  await runMonitorChunkRecoveryScenario(
    healthScenarioDeps({ address, captureCommand, renderCommand }),
  );
  console.log("Agent fake-controller smoke passed.");
} finally {
  server.close();
  await rm(smokeRoot, { force: true, recursive: true });
}

async function runScenario({ address, captureCommand, renderCommand, scenario }) {
  const stateFile = path.join(smokeRoot, `${scenario.name}-agent-state.json`);
  const healthLogFile = path.join(smokeRoot, `${scenario.name}-health-events.jsonl`);
  const job = createJob(scenario);
  const observed = createObserved();
  activeScenario = { job, jobs: [job], observed, scenario };
  const agentArgs = [
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
    "--agent-state-file",
    stateFile,
    "--capture-command",
    captureCommand,
  ];

  if (scenario.captureArgsTemplate) {
    agentArgs.push("--capture-args-template", scenario.captureArgsTemplate);
  }

  agentArgs.push(
    "--capture-growth-grace-seconds",
    "0",
    "--capture-stalled-seconds",
    String(scenario.captureStalledSeconds ?? 30),
    "--capture-min-output-bytes",
    "44",
    "--controller-token",
    token,
    "--controller-url",
    `http://127.0.0.1:${address.port}`,
    "--channel-render-command",
    renderCommand,
    "--job-poll-seconds",
    "1",
    "--node-id",
    nodeId,
    "--run-next-job",
  );

  const result = await run("cargo", agentArgs, { cwd: smokeRoot });

  if (scenario.expectSuccess && result.code !== 0) {
    throw new Error(
      `${scenario.name} fake-controller smoke failed with exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  if (!scenario.expectSuccess && result.code === 0) {
    throw new Error(`${scenario.name} fake-controller smoke unexpectedly succeeded`);
  }
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const healthLogEvents = await readJsonLines(healthLogFile);
  const renderedLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.output_rendered",
  );
  const retentionLocalEvent = healthLogEvents.find(
    (event) => event.type === "agent.recording_job.recorder_cache_deleted",
  );

  invariant(observed.claimNextReads === 1, "agent did not claim the next queued job");
  invariant(observed.claims === 1, "agent did not claim exactly one queued job");
  invariant(observed.heartbeats >= 1, "agent did not heartbeat the running job");
  invariant(observed.jobStatusReads >= 1, "agent did not poll the running job status");
  invariant(observed.channelMapReads === 1, "agent did not fetch channel-map assignments");

  if (scenario.expectRenderFailure) {
    assertRenderFailureScenario({ healthLogEvents, job, observed, scenario, state });
  } else if (scenario.expectStalledCapture) {
    assertStalledCaptureScenario({ healthLogEvents, job, observed, scenario, state });
  } else if (scenario.controllerStopRequested) {
    assertControllerStopScenario({ healthLogEvents, job, observed, scenario, state });
  } else {
    assertRenderedOutputScenario({ observed, renderedLocalEvent, scenario });
  }

  if (scenario.expectSuccess && !scenario.controllerStopRequested) {
    await assertCompletedScenario({ job, retentionLocalEvent, scenario, state });
  } else if (scenario.cacheUploadFails) {
    assertCacheUploadFailureScenario({ healthLogEvents, job, observed, scenario, state });
  }
  activeScenario = undefined;
}

async function runConcurrentScenario({ address, captureCommand, renderCommand }) {
  const stateFile = path.join(smokeRoot, "concurrent-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "concurrent-health-events.jsonl");
  const jobs = [
    createJob({
      expectSuccess: true,
      jobId: "job_fake_controller_concurrent_a",
      name: "concurrent-a",
      outputFileName: "rec_fake_controller_concurrent_a.mp3",
      recordingId: "rec_fake_controller_concurrent_a",
    }),
    createJob({
      expectSuccess: true,
      jobId: "job_fake_controller_concurrent_b",
      name: "concurrent-b",
      outputFileName: "rec_fake_controller_concurrent_b.mp3",
      recordingId: "rec_fake_controller_concurrent_b",
    }),
  ];
  const observed = createObserved();
  activeScenario = {
    jobs,
    observed,
    scenario: {
      concurrent: true,
      expectSuccess: true,
      name: "concurrent",
    },
  };
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
        jobs.every((job) => job.status === "completed") &&
        observed.cacheUploads.length === 2 &&
        observed.healthEvents.filter(
          (event) => event.type === "agent.recording_job.recorder_cache_deleted",
        ).length === 2,
      20_000,
      () =>
        `jobs=${jobs.map((job) => `${job.id}:${job.status}`).join(",")} uploads=${observed.cacheUploads.length}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const healthLogEvents = await readJsonLines(healthLogFile);
  const renderedEvents = healthLogEvents.filter(
    (event) => event.type === "agent.recording_job.output_rendered",
  );

  invariant(observed.configReads >= 1, "concurrent agent did not read controller node config");
  invariant(observed.claimNextReads >= 2, "concurrent agent did not claim queued jobs");
  invariant(observed.claims === 2, "concurrent agent did not claim both queued jobs");
  invariant(observed.monitorChunks.length >= 1, "concurrent agent did not sync monitor chunks");
  invariant(observed.maxRunningJobs >= 2, "concurrent jobs did not overlap as running");
  invariant(
    renderedEvents.length === 2,
    "concurrent local health log did not include both renders",
  );
  invariant(
    observed.cacheUploads.every((upload) => upload.contentType === "audio/mpeg"),
    "concurrent cache uploads were not rendered MP3",
  );
  activeScenario = undefined;
}

async function runDeferredSweepScenario({ address, captureCommand, renderCommand }) {
  const stateFile = path.join(smokeRoot, "deferred-sweep-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "deferred-sweep-health-events.jsonl");
  const jobs = ["a", "b"].map((suffix) =>
    createJob({
      expectSuccess: true,
      jobId: `job_fake_controller_deferred_sweep_${suffix}`,
      name: `deferred-sweep-${suffix}`,
      outputFileName: `rec_fake_controller_deferred_sweep_${suffix}.mp3`,
      recordingId: `rec_fake_controller_deferred_sweep_${suffix}`,
      recorderCacheRetention: deferredSweepRetention(),
    }),
  );
  const observed = createObserved();
  activeScenario = {
    jobs,
    observed,
    scenario: {
      concurrent: true,
      deferredSweep: true,
      expectSuccess: true,
      name: "deferred-sweep",
    },
  };
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
        jobs.every((job) => job.status === "completed") &&
        observed.cacheUploads.length === 2 &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recorder_cache.sweep_completed",
        ),
      60_000,
      () =>
        `jobs=${jobs.map((job) => `${job.id}:${job.status}`).join(",")} uploads=${observed.cacheUploads.length} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const healthLogEvents = await readJsonLines(healthLogFile);
  const sweepEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recorder_cache.sweep_completed",
  );

  invariant(
    healthLogEvents.filter((event) => event.type === "agent.recording_job.recorder_cache_tracked")
      .length === 2,
    "deferred retention jobs were not tracked in the local health log",
  );
  invariant(
    sweepEvent?.details?.deleted >= 1,
    "deferred recorder-cache sweep did not delete files",
  );

  activeScenario = undefined;
}

async function runMinFreeSweepScenario({ address, captureCommand, fakeDfPath, renderCommand }) {
  const stateFile = path.join(smokeRoot, "min-free-sweep-agent-state.json");
  const healthLogFile = path.join(smokeRoot, "min-free-sweep-health-events.jsonl");
  const jobs = ["a", "b"].map((suffix) =>
    createJob({
      expectSuccess: true,
      jobId: `job_fake_controller_min_free_sweep_${suffix}`,
      name: `min-free-sweep-${suffix}`,
      outputFileName: `rec_fake_controller_min_free_sweep_${suffix}.mp3`,
      recordingId: `rec_fake_controller_min_free_sweep_${suffix}`,
      recorderCacheRetention: minFreeSweepRetention(),
    }),
  );
  const observed = createObserved();
  activeScenario = {
    jobs,
    observed,
    scenario: {
      concurrent: true,
      expectSuccess: true,
      minFreeSweep: true,
      name: "min-free-sweep",
    },
  };
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
    ["--system-health-df-command", fakeDfCommandPath(fakeDfPath)],
  );

  try {
    await waitFor(
      () =>
        jobs.every((job) => job.status === "completed") &&
        observed.cacheUploads.length === 2 &&
        observed.healthEvents.some(
          (event) => event.type === "agent.recorder_cache.sweep_completed",
        ),
      20_000,
      () =>
        `jobs=${jobs.map((job) => `${job.id}:${job.status}`).join(",")} uploads=${observed.cacheUploads.length} health=${observed.healthEvents.map((event) => event.type).join(",")}`,
    );
  } finally {
    child.kill();
    await child.closed;
  }
  const sweepEvent = observed.healthEvents.find(
    (event) => event.type === "agent.recorder_cache.sweep_completed",
  );

  invariant(
    sweepEvent?.details?.deleted >= 1,
    "min-free recorder-cache sweep did not delete files",
  );
  invariant(
    sweepEvent?.details?.items?.some((item) => item.reason === "min_free_disk"),
    "min-free recorder-cache sweep did not report min_free_disk reason",
  );

  await assertAnyLocalRecorderCacheDeleted(jobs.map((job) => job.command.outputFileName));
  activeScenario = undefined;
}

function assertRenderedOutputScenario({ observed, renderedLocalEvent, scenario }) {
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
}

async function assertCompletedScenario({ job, retentionLocalEvent, scenario, state }) {
  invariant(job.status === "completed", "fake controller did not mark job completed");
  invariant(state.status === "completed", "agent state file did not end completed");
  invariant(state.jobId === scenario.jobId, "agent state file recorded the wrong job id");
  invariant(
    state.outputPath?.endsWith(scenario.outputFileName),
    "agent state did not end on rendered MP3",
  );
  invariant(retentionLocalEvent, "agent did not log recorder-cache retention cleanup");
  invariant(
    retentionLocalEvent.details?.policyId === job.command.recorderCacheRetention.policyId,
    "recorder-cache cleanup did not include the retention policy id",
  );
  await assertLocalRecorderCacheDeleted(scenario.outputFileName);
}

function assertControllerStopScenario({ healthLogEvents, job, observed, scenario, state }) {
  invariant(job.status === "cancelled", "fake controller did not mark stopped job cancelled");
  invariant(observed.cancellations === 1, "agent did not mark stop-requested job cancelled");
  invariant(
    observed.cancelReason === "controller_stop_requested",
    "agent cancellation reason did not preserve controller stop request",
  );
  invariant(!observed.cacheUpload, "agent uploaded cache after controller stop request");
  invariant(
    state.status === "cancelled",
    "agent state file did not end cancelled after controller stop request",
  );
  invariant(state.jobId === scenario.jobId, "cancelled agent state file recorded the wrong job id");
  invariant(
    state.reason === "controller_stop_requested",
    "cancelled state did not retain stop request reason",
  );
  invariant(
    !healthLogEvents.some((event) => event.type === "agent.recording_job.output_rendered"),
    "agent rendered output after controller stop request",
  );
}

function createJob(scenario) {
  return {
    command: {
      captureChannels: 1,
      captureDevice: "fake-device",
      captureFormat: "S16_LE",
      captureSampleRate: 48000,
      durationSeconds: 1,
      outputBitrateKbps: 128,
      outputCodec: "mp3",
      outputFileName: scenario.outputFileName,
      outputVbr: true,
      recorderCacheRetention: scenario.recorderCacheRetention ?? immediateRetention(),
      type: "alsa_capture",
    },
    failureReason: undefined,
    id: scenario.jobId,
    nodeId,
    recordingId: scenario.recordingId,
    status: "queued",
  };
}

function immediateRetention() {
  return {
    deleteAfterUpload: true,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: null,
    policyId: "retention-recorder-cache-smoke",
  };
}

function deferredSweepRetention() {
  return {
    deleteAfterUpload: false,
    maxAgeDays: null,
    maxBytes: 1,
    minFreeDiskPercent: null,
    policyId: "retention-recorder-cache-sweep-smoke",
  };
}

function minFreeSweepRetention() {
  return {
    deleteAfterUpload: false,
    maxAgeDays: null,
    maxBytes: null,
    minFreeDiskPercent: 95,
    policyId: "retention-recorder-cache-min-free-smoke",
  };
}

function recorderCachePoliciesForScenario(scenario) {
  if (scenario.deferredSweep) {
    return [deferredSweepRetention()];
  }

  if (scenario.minFreeSweep) {
    return [minFreeSweepRetention()];
  }

  return [];
}

async function assertLocalRecorderCacheDeleted(outputFileName) {
  const [renderedPath, rawPath] = localRecorderCachePaths(smokeRoot, outputFileName);
  invariant(!(await fileExists(renderedPath)), `rendered recorder cache remains: ${renderedPath}`);
  invariant(!(await fileExists(rawPath)), `raw recorder cache remains: ${rawPath}`);
}

async function assertAnyLocalRecorderCacheDeleted(outputFileNames) {
  for (const outputFileName of outputFileNames) {
    const [renderedPath, rawPath] = localRecorderCachePaths(smokeRoot, outputFileName);
    if (!(await fileExists(renderedPath)) || !(await fileExists(rawPath))) {
      return;
    }
  }

  throw new Error("min-free recorder-cache sweep did not remove any local cache files");
}

function fakeDfCommandPath(fakeDfPath) {
  return path.join(fakeDfPath, process.platform === "win32" ? "df.cmd" : "df");
}

function healthScenarioDeps(overrides) {
  return {
    ...overrides,
    createObserved,
    setActiveScenario: (scenario) => {
      activeScenario = scenario;
    },
    smokeRoot,
    spawnDaemonAgent: ({
      address,
      captureCommand,
      extraAgentArgs = [],
      extraEnv = {},
      healthLogFile,
      meterBackend,
      renderCommand,
      stateFile,
    }) =>
      spawnDaemonAgent(
        agentContext,
        address,
        captureCommand,
        healthLogFile,
        renderCommand,
        stateFile,
        extraEnv,
        meterBackend ? ["--meter-backend", meterBackend, ...extraAgentArgs] : extraAgentArgs,
      ),
  };
}

function createObserved() {
  return {
    cancelReason: undefined,
    cancellations: 0,
    cacheUpload: undefined,
    cacheUploads: [],
    channelMapReads: 0,
    claimNextReads: 0,
    claims: 0,
    configReads: 0,
    failureReason: undefined,
    failures: 0,
    heartbeats: 0,
    healthEvents: [],
    jobStatusReads: 0,
    maxRunningJobs: 0,
    meterFrames: 0,
    monitorChunkFailures: 0,
    monitorChunks: [],
    nextReads: 0,
    nodeHeartbeats: 0,
  };
}

async function handleControllerRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const context = activeScenario;

  if (request.headers.authorization !== `Bearer ${token}`) {
    return json(response, 401, { error: "invalid token" });
  }

  if (!context) {
    await readBody(request);
    return json(response, 503, { error: "no active smoke scenario" });
  }

  const { observed, scenario } = context;
  const jobs = context.jobs ?? [context.job];

  if (request.method === "GET" && url.pathname === `/api/v1/nodes/${nodeId}/config`) {
    observed.configReads += 1;
    return json(response, 200, {
      data: {
        recordingCapacity: {
          maxConcurrentRecordings: scenario.concurrent ? 2 : 1,
        },
        recorderCachePolicies: recorderCachePoliciesForScenario(scenario),
      },
    });
  }

  if (request.method === "GET" && url.pathname === `/api/v1/nodes/${nodeId}/recording-jobs/next`) {
    observed.nextReads += 1;
    const job = nextQueuedJob(jobs);

    return job ? json(response, 200, { data: job }) : empty(response);
  }

  if (
    request.method === "POST" &&
    url.pathname === `/api/v1/nodes/${nodeId}/recording-jobs/claim-next`
  ) {
    observed.claimNextReads += 1;
    const job = nextQueuedJob(jobs);

    if (!job) {
      return empty(response);
    }

    observed.claims += 1;
    job.status = "running";
    rememberRunningJobs(observed, jobs);
    return json(response, 200, { data: job });
  }

  if (
    request.method === "GET" &&
    url.pathname === `/api/v1/nodes/${nodeId}/channel-map-assignments`
  ) {
    observed.channelMapReads += 1;
    return json(response, 200, { data: [] });
  }

  if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/heartbeat`) {
    await readBody(request);
    observed.nodeHeartbeats += 1;
    return json(response, 202, { data: { ok: true } });
  }

  if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/meter-frame`) {
    await readBody(request);
    observed.meterFrames += 1;
    return json(response, 202, { data: { ok: true } });
  }

  if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/listen/chunk`) {
    const body = await readBody(request);
    if (scenario.monitorChunkFailuresRemaining > 0) {
      scenario.monitorChunkFailuresRemaining -= 1;
      observed.monitorChunkFailures += 1;
      return json(response, 503, { error: "simulated monitor chunk failure" });
    }

    observed.monitorChunks.push({
      capturedAt: request.headers["x-rakkr-captured-at"],
      contentType: request.headers["content-type"],
      durationMs: request.headers["x-rakkr-duration-ms"],
      size: body.byteLength,
    });
    return json(response, 202, { data: { ok: true } });
  }

  const claimMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/claim$/);

  if (request.method === "POST" && claimMatch) {
    const job = jobById(jobs, claimMatch[1]);

    if (!job) {
      await readBody(request);
      return json(response, 404, { error: "job not found" });
    }

    observed.claims += 1;
    job.status = "running";
    rememberRunningJobs(observed, jobs);
    return json(response, 200, { data: job });
  }

  const heartbeatMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/heartbeat$/);

  if (request.method === "POST" && heartbeatMatch) {
    const job = jobById(jobs, heartbeatMatch[1]);

    if (!job) {
      await readBody(request);
      return json(response, 404, { error: "job not found" });
    }

    observed.heartbeats += 1;
    return json(response, 200, { data: job });
  }

  const readMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)$/);

  if (request.method === "GET" && readMatch) {
    const job = jobById(jobs, readMatch[1]);

    if (!job) {
      return json(response, 404, { error: "job not found" });
    }

    observed.jobStatusReads += 1;
    if (scenario.controllerStopRequested) {
      job.status = "stop_requested";
    }

    return json(response, 200, { data: job });
  }

  const cancelledMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/cancelled$/);

  if (request.method === "POST" && cancelledMatch) {
    const job = jobById(jobs, cancelledMatch[1]);

    if (!job) {
      await readBody(request);
      return json(response, 404, { error: "job not found" });
    }

    observed.cancellations += 1;
    observed.cancelReason = request.headers["x-rakkr-reason"];
    job.failureReason = observed.cancelReason;
    job.status = "cancelled";
    return json(response, 200, { data: job });
  }

  const failedMatch = url.pathname.match(/^\/api\/v1\/recording-jobs\/([^/]+)\/failed$/);

  if (request.method === "POST" && failedMatch) {
    const job = jobById(jobs, failedMatch[1]);

    if (!job) {
      await readBody(request);
      return json(response, 404, { error: "job not found" });
    }

    observed.failures += 1;
    observed.failureReason = request.headers["x-rakkr-reason"];
    job.failureReason = observed.failureReason;
    job.status = "failed";
    return json(response, 200, { data: job });
  }

  if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/health-events`) {
    const event = JSON.parse((await readBody(request)).toString("utf8"));
    observed.healthEvents.push(event);
    return json(response, 201, { data: { id: `health_${observed.healthEvents.length}` } });
  }

  const cacheMatch = url.pathname.match(/^\/api\/v1\/recordings\/([^/]+)\/cache-file$/);

  if (request.method === "PUT" && cacheMatch) {
    const job = jobByRecordingId(jobs, cacheMatch[1]);

    if (!job) {
      await readBody(request);
      return json(response, 404, { error: "recording job not found" });
    }

    const body = await readBody(request);

    const upload = {
      contentType: request.headers["content-type"],
      durationSeconds: request.headers["x-rakkr-duration-seconds"],
      fileName: request.headers["x-rakkr-file-name"],
      jobId: request.headers["x-rakkr-recording-job-id"],
      recordingId: job.recordingId,
      size: body.byteLength,
    };
    observed.cacheUpload = upload;
    observed.cacheUploads.push(upload);

    if (scenario.cacheUploadFails) {
      return json(response, 503, { error: "simulated cache upload failure" });
    }

    job.status = "completed";

    return json(response, 201, { data: { ok: true } });
  }

  await readBody(request);
  return json(response, 404, { error: `unexpected route ${request.method} ${url.pathname}` });
}

function nextQueuedJob(jobs) {
  return jobs.find((job) => job.status === "queued");
}

function jobById(jobs, jobId) {
  return jobs.find((job) => job.id === jobId);
}

function jobByRecordingId(jobs, recordingId) {
  return jobs.find((job) => job.recordingId === recordingId);
}

function rememberRunningJobs(observed, jobs) {
  observed.maxRunningJobs = Math.max(
    observed.maxRunningJobs,
    jobs.filter((job) => job.status === "running").length,
  );
}
