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
const recordingId = "rec_fake_controller_smoke";
const jobId = "job_fake_controller_smoke";
const token = "node-token";
const stateFile = path.join(smokeRoot, "agent-state.json");
const healthLogFile = path.join(smokeRoot, "health-events.jsonl");
const observed = {
  cacheUpload: undefined,
  channelMapReads: 0,
  claims: 0,
  healthEvents: 0,
  nextReads: 0,
};
const job = {
  command: {
    captureChannels: 1,
    captureDevice: "fake-device",
    captureFormat: "S16_LE",
    captureSampleRate: 48000,
    durationSeconds: 1,
    outputCodec: "wav",
    outputFileName: "rec_fake_controller_smoke.wav",
    outputVbr: false,
    type: "alsa_capture",
  },
  failureReason: undefined,
  id: jobId,
  nodeId,
  recordingId,
  status: "queued",
};

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
    "--job-poll-seconds",
    "1",
    "--node-id",
    nodeId,
    "--run-next-job",
  ]);

  if (result.code !== 0) {
    throw new Error(
      `agent fake-controller smoke failed with exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const state = JSON.parse(await readFile(stateFile, "utf8"));

  invariant(observed.nextReads === 1, "agent did not read the next queued job");
  invariant(observed.claims === 1, "agent did not claim the queued job");
  invariant(observed.channelMapReads === 1, "agent did not fetch channel-map assignments");
  invariant(observed.cacheUpload?.recordingId === recordingId, "agent did not upload cache file");
  invariant(observed.cacheUpload?.jobId === jobId, "cache upload did not include the job id");
  invariant(observed.cacheUpload?.durationSeconds === "1", "cache upload did not include duration");
  invariant(observed.cacheUpload?.contentType === "audio/wav", "cache upload was not WAV");
  invariant(observed.cacheUpload?.size > 44, "cache upload body was too small");
  invariant(job.status === "completed", "fake controller did not mark job completed");
  invariant(state.status === "completed", "agent state file did not end completed");
  invariant(state.jobId === jobId, "agent state file recorded the wrong job id");

  console.log("Agent fake-controller smoke passed.");
} finally {
  server.close();
  await rm(smokeRoot, { force: true, recursive: true });
}

async function handleControllerRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.headers.authorization !== `Bearer ${token}`) {
    return json(response, 401, { error: "invalid token" });
  }

  if (request.method === "GET" && url.pathname === `/api/v1/nodes/${nodeId}/recording-jobs/next`) {
    observed.nextReads += 1;
    return json(response, 200, { data: job });
  }

  if (request.method === "GET" && url.pathname === `/api/v1/nodes/${nodeId}/channel-map-assignments`) {
    observed.channelMapReads += 1;
    return json(response, 200, { data: [] });
  }

  if (request.method === "POST" && url.pathname === `/api/v1/recording-jobs/${jobId}/claim`) {
    observed.claims += 1;
    job.status = "running";
    return json(response, 200, { data: job });
  }

  if (request.method === "POST" && url.pathname === `/api/v1/recording-jobs/${jobId}/heartbeat`) {
    return json(response, 200, { data: job });
  }

  if (request.method === "GET" && url.pathname === `/api/v1/recording-jobs/${jobId}`) {
    return json(response, 200, { data: job });
  }

  if (request.method === "POST" && url.pathname === `/api/v1/nodes/${nodeId}/health-events`) {
    observed.healthEvents += 1;
    await readBody(request);
    return json(response, 201, { data: { id: `health_${observed.healthEvents}` } });
  }

  if (request.method === "PUT" && url.pathname === `/api/v1/recordings/${recordingId}/cache-file`) {
    const body = await readBody(request);

    observed.cacheUpload = {
      contentType: request.headers["content-type"],
      durationSeconds: request.headers["x-rakkr-duration-seconds"],
      fileName: request.headers["x-rakkr-file-name"],
      jobId: request.headers["x-rakkr-recording-job-id"],
      recordingId,
      size: body.byteLength,
    };
    job.status = "completed";

    return json(response, 201, { data: { ok: true } });
  }

  await readBody(request);
  return json(response, 404, { error: `unexpected route ${request.method} ${url.pathname}` });
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

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
