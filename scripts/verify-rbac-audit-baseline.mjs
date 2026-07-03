import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const baselineFile = "docs/internal/baselines/RBAC_AUDIT_BASELINE.md";
const sharedFile = "packages/shared/src/index.ts";
const apiSourceDirectory = "apps/api/src";
const requiredPhrases = [
  "Default deny",
  "Exact permission",
  "Resource-scoped",
  "Explicit deny wins",
  "user, group, and everyone",
  "API enforces",
  "UI helpers mirror",
  "denied attempts",
  "Room Roster Capabilities",
  "per-action capabilities",
  "explicit deny access-policy always overrides",
  "grantedViaRoomCapability",
  "Room ownership is per-channel",
  "spanning rooms is rejected",
];
const requiredApiIdentifiers = [
  "roomCapabilityAuthorizes",
  "roomRosterStore",
  "permissionRequiresCapability",
  "channelRoomId",
  "nodeRoomIds",
];
const errors = [];

const [baseline, sharedSource] = await Promise.all([
  readFile(baselineFile, "utf8"),
  readFile(sharedFile, "utf8"),
]);
const permissions = extractSharedPermissions(sharedSource);
const matrixPermissions = extractMatrixPermissions(baseline);
const apiSources = await readSourceFiles(apiSourceDirectory);
const apiSourceText = apiSources.map((source) => source.content).join("\n");

if (permissions.length === 0) {
  errors.push(`could not extract permissions from ${sharedFile}`);
}

for (const phrase of requiredPhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const identifier of requiredApiIdentifiers) {
  if (!apiSourceText.includes(identifier)) {
    errors.push(`API source must reference schedule-assignment identifier ${identifier}`);
  }
}

for (const permission of permissions) {
  if (!matrixPermissions.has(permission)) {
    errors.push(`${baselineFile} is missing matrix row for ${permission}`);
  }

  if (permission === "system:admin") {
    if (!/owner-only/i.test(baseline)) {
      errors.push(`${baselineFile} must document system:admin as owner-only`);
    }
    continue;
  }

  if (!apiSourceText.includes(`"${permission}"`)) {
    errors.push(`API source does not reference permission ${permission}`);
  }
}

for (const permission of matrixPermissions) {
  if (!permissions.includes(permission)) {
    errors.push(`${baselineFile} documents unknown permission ${permission}`);
  }
}

for (const reference of markdownPathReferences(baseline)) {
  try {
    await access(reference);
  } catch {
    errors.push(`${baselineFile} references missing file ${reference}`);
  }
}

for (const source of apiSources) {
  validateApiPermissionLiterals(source);
}

if (errors.length > 0) {
  console.error(`Invalid RBAC/audit baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified ${permissions.length} RBAC permissions in ${baselineFile}.`);

function extractSharedPermissions(source) {
  const match = source.match(/export const permissions = \[([\s\S]*?)\] as const;/u);
  return match ? Array.from(match[1].matchAll(/"([^"]+)"/gu), (permission) => permission[1]) : [];
}

function extractMatrixPermissions(markdown) {
  return new Set(
    Array.from(markdown.matchAll(/^\|\s*`([^`]+)`\s*\|/gmu), (permission) => permission[1]),
  );
}

function markdownPathReferences(markdown) {
  return Array.from(
    markdown.matchAll(/`((?:apps|docs|packages|scripts)\/[^`]+?)`/gu),
    (reference) => reference[1].replaceAll("/", path.sep),
  );
}

async function readSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return readSourceFiles(entryPath);
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return [];
      }

      return [{ content: await readFile(entryPath, "utf8"), path: entryPath }];
    }),
  );

  return files.flat();
}

function validateApiPermissionLiterals(source) {
  const knownPermissions = new Set(permissions);
  const patterns = [
    /requirePermission\(\s*"([^"]+)"/gu,
    /permission:\s*"([^"]+)"/gu,
  ];

  for (const pattern of patterns) {
    for (const match of source.content.matchAll(pattern)) {
      if (!knownPermissions.has(match[1])) {
        errors.push(`${source.path} references unknown permission literal ${match[1]}`);
      }
    }
  }
}
