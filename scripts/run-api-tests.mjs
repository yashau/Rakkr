import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const apiRoot = path.join(repoRoot, "apps", "api");
const isWindows = process.platform === "win32";
const command = isWindows ? "cmd.exe" : "pnpm";
const args = isWindows
  ? ["/d", "/s", "/c", "pnpm exec tsx --test test/**/*.test.ts"]
  : ["exec", "tsx", "--test", "test/**/*.test.ts"];
const databaseUrl = process.env.RAKKR_API_TEST_DATABASE_URL ?? "";
const env = {
  ...process.env,
  RAKKR_API_NO_LISTEN: process.env.RAKKR_API_NO_LISTEN ?? "1",
};

if (databaseUrl) {
  env.DATABASE_URL = databaseUrl;
} else {
  delete env.DATABASE_URL;
}

const child = spawn(command, args, {
  cwd: apiRoot,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`API tests exited from signal ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
