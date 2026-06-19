#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const smokeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-fake-controller-"));
const nodeId = "node_fake_controller_smoke";
const token = "node-token";
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
  const renderCommand = await writeFakeRenderCommand(smokeRoot);

  for (const scenario of scenarios) {
    await runScenario({ address, captureCommand, renderCommand, scenario });
  }

  await runConcurrentScenario({ address, captureCommand, renderCommand });

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
  const result = await run("cargo", [
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
    "--capture-growth-grace-seconds",
    "0",
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
  ]);

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

  invariant(observed.claimNextReads === 1, "agent did not claim the next queued job");
  invariant(observed.claims === 1, "agent did not claim exactly one queued job");
  invariant(observed.heartbeats >= 1, "agent did not heartbeat the running job");
  invariant(observed.jobStatusReads >= 1, "agent did not poll the running job status");
  invariant(observed.channelMapReads === 1, "agent did not fetch channel-map assignments");

  if (scenario.controllerStopRequested) {
    assertControllerStopScenario({ healthLogEvents, job, observed, scenario, state });
  } else {
    assertRenderedOutputScenario({ observed, renderedLocalEvent, scenario });
  }

  if (scenario.expectSuccess && !scenario.controllerStopRequested) {
    assertCompletedScenario({ job, scenario, state });
  } else if (!scenario.expectSuccess) {
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

  const child = spawnAgent([
    "--allow-insecure-controller",
    "--agent-health-log-file",
    healthLogFile,
    "--agent-state-file",
    stateFile,
    "--capture-command",
    captureCommand,
    "--capture-growth-grace-seconds",
    "0",
    "--capture-min-output-bytes",
    "44",
    "--controller-token",
    token,
    "--controller-url",
    `http://127.0.0.1:${address.port}`,
    "--channel-render-command",
    renderCommand,
    "--heartbeat-seconds",
    "1",
    "--job-poll-seconds",
    "1",
    "--max-concurrent-recordings",
    "2",
    "--meter-backend",
    "synthetic",
    "--node-id",
    nodeId,
  ]);

  try {
    await waitFor(
      () => jobs.every((job) => job.status === "completed") && observed.cacheUploads.length === 2,
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

  invariant(observed.claimNextReads >= 2, "concurrent agent did not claim queued jobs");
  invariant(observed.claims === 2, "concurrent agent did not claim both queued jobs");
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

function assertCompletedScenario({ job, scenario, state }) {
  invariant(job.status === "completed", "fake controller did not mark job completed");
  invariant(state.status === "completed", "agent state file did not end completed");
  invariant(state.jobId === scenario.jobId, "agent state file recorded the wrong job id");
  invariant(
    state.outputPath?.endsWith(scenario.outputFileName),
    "agent state did not end on rendered MP3",
  );
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

function assertCacheUploadFailureScenario({ healthLogEvents, job, observed, scenario, state }) {
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
      type: "alsa_capture",
    },
    failureReason: undefined,
    id: scenario.jobId,
    nodeId,
    recordingId: scenario.recordingId,
    status: "queued",
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
    failureReason: undefined,
    failures: 0,
    heartbeats: 0,
    healthEvents: [],
    jobStatusReads: 0,
    maxRunningJobs: 0,
    meterFrames: 0,
    nextReads: 0,
    nodeHeartbeats: 0,
  };
}

async function readJsonLines(filePath) {
  try {
    return (await readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("HTTP server did not return a TCP address"));
        return;
      }

      resolve(address);
    });
  });
}

async function writeFakeCaptureCommand(directory) {
  const captureScript = path.join(directory, "fake-capture.mjs");
  await writeFile(
    captureScript,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputPath = process.argv.at(-1);

if (!outputPath || outputPath.startsWith("-")) {
  console.error("missing output path");
  process.exit(2);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, wavFile([0, 12000, -12000, 6000, -6000, 3000]));
await new Promise((resolve) => setTimeout(resolve, 750));

function wavFile(samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(96000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));

  return buffer;
}
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-capture.cmd");
    await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`);

    return commandPath;
  }

  await chmod(captureScript, 0o755);

  return captureScript;
}

async function writeFakeRenderCommand(directory) {
  const renderScript = path.join(directory, "fake-render.mjs");
  await writeFile(
    renderScript,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const inputIndex = process.argv.indexOf("-i");
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
const outputPath = process.argv.at(-1);

if (!inputPath || !outputPath || outputPath.startsWith("-")) {
  console.error("missing input or output path");
  process.exit(2);
}

mkdirSync(path.dirname(outputPath), { recursive: true });
const source = readFileSync(inputPath);
const payload = Buffer.concat([Buffer.from("FAKE_MP3_VBR_128\\n"), source]);
writeFileSync(outputPath, payload);
`,
  );

  if (process.platform === "win32") {
    const commandPath = path.join(directory, "fake-render.cmd");
    await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${renderScript}" %*\r\n`);

    return commandPath;
  }

  await chmod(renderScript, 0o755);

  return renderScript;
}

function spawnAgent(agentArgs) {
  const child = spawn(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      path.join(repoRoot, "Cargo.toml"),
      "-p",
      "rakkr-recorder-agent",
      "--",
      ...agentArgs,
    ],
    {
      cwd: smokeRoot,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  let stdout = "";
  const closed = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr, stdout }));
  });

  return {
    closed,
    kill: () => child.kill(),
  };
}

function run(command, args) {
  const timeoutMs = Number(process.env.RAKKR_AGENT_FAKE_CONTROLLER_TIMEOUT_MS ?? 120000);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: smokeRoot,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let done = false;
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill();
      finish({ code: -1, stderr: `${stderr}\nprocess timed out after ${timeoutMs}ms`, stdout });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => finish({ code: code ?? -1, stderr, stdout }));

    function finish(result) {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timeout);
      resolve(result);
    }
  });
}

async function waitFor(predicate, timeoutMs, describe) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for condition: ${describe()}`);
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function empty(response) {
  response.writeHead(204);
  response.end();
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
