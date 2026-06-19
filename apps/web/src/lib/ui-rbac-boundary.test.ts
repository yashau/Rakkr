import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const checkedPaths = ["main.tsx", "components", "pages"].map((entry) => join(sourceRoot, entry));

test("ui pages and components derive RBAC state through tested helpers", () => {
  const directPermissionChecks = checkedPaths
    .flatMap((checkedPath) => sourceFiles(checkedPath))
    .filter((filePath) => readFileSync(filePath, "utf8").match(/\bpermissions\.includes\s*\(/u))
    .map((filePath) => relative(sourceRoot, filePath).replaceAll("\\", "/"));

  assert.deepEqual(directPermissionChecks, []);
});

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) {
    return isSourceFile(path) ? [path] : [];
  }

  return readdirSync(path)
    .map((entry) => join(path, entry))
    .flatMap((entryPath) => sourceFiles(entryPath));
}

function isSourceFile(path: string) {
  return (path.endsWith(".ts") || path.endsWith(".tsx")) && !path.endsWith(".test.ts");
}
