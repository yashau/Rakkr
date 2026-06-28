import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export function listen(server) {
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

export function agentBinaryPath(repoRoot) {
  const binary =
    process.platform === "win32" ? "rakkr-recorder-agent.exe" : "rakkr-recorder-agent";

  return path.join(repoRoot, "target", "debug", binary);
}

/**
 * Terminate a child and its descendants. Plain `child.kill()` on Windows only
 * signals the immediate process, leaving grandchildren (rustc, the agent, its
 * capture/render commands) alive holding the stdio pipes open — which keeps the
 * `close` event from ever firing and hangs the smoke. Kill the whole tree.
 */
export function killTree(child) {
  if (!child || child.pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      child.kill();
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

export function run(command, args, { cwd, timeoutMs } = {}) {
  const limitMs = Number(timeoutMs ?? process.env.RAKKR_AGENT_FAKE_CONTROLLER_TIMEOUT_MS ?? 120000);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let done = false;
    let stderr = "";
    let stdout = "";
    const timeout = setTimeout(() => {
      killTree(child);
      finish({ code: -1, stderr: `${stderr}\nprocess timed out after ${limitMs}ms`, stdout });
    }, limitMs);

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

export async function waitFor(predicate, timeoutMs, describe) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for condition: ${describe()}`);
}

export async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

export function empty(response) {
  response.writeHead(204);
  response.end();
}

export function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function readJsonLines(filePath) {
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

export function localRecorderCachePaths(rootDirectory, outputFileName) {
  const cacheDir = path.join(rootDirectory, "data", "recordings", "local-captures");

  return [
    path.join(cacheDir, outputFileName),
    path.join(cacheDir, outputFileName.replace(/\.[^.]+$/, ".raw.wav")),
  ];
}
