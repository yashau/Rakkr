import { spawn } from "node:child_process";

import { killTree } from "./agent-fake-controller-smoke-utils.mjs";

export function spawnDaemonAgent(
  context,
  address,
  captureCommand,
  healthLogFile,
  renderCommand,
  stateFile,
  extraEnv = {},
  extraAgentArgs = [],
) {
  const agentArgs = [
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
    context.token,
    "--controller-url",
    `http://127.0.0.1:${address.port}`,
    "--channel-render-command",
    renderCommand,
    "--heartbeat-seconds",
    "1",
    "--job-poll-seconds",
    "1",
    "--max-concurrent-recordings",
    "1",
  ];

  if (!extraAgentArgs.includes("--meter-backend")) {
    agentArgs.push("--meter-backend", "synthetic");
  }

  agentArgs.push("--node-id", context.nodeId, ...extraAgentArgs);

  return spawnAgent(context, agentArgs, extraEnv);
}

function spawnAgent(context, agentArgs, extraEnv = {}) {
  const child = spawn(context.agentBinary, agentArgs, {
    cwd: context.smokeRoot,
    env: { ...process.env, ...extraEnv, CARGO_TERM_COLOR: "never" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
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
    kill: () => killTree(child),
  };
}
