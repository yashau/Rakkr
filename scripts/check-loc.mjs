import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const maxLines = Number(process.env.RAKKR_MAX_FILE_LOC ?? 1000);

const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  ".vite",
  "dist",
  "node_modules",
  "target",
]);

const ignoredPathParts = [
  path.join("packages", "db", "drizzle"),
  path.join("apps", "web", "dist"),
];

const ignoredFiles = new Set(["pnpm-lock.yaml", "Cargo.lock"]);
const ignoredExtensions = new Set([
  ".flac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".ogg",
  ".png",
  ".wav",
  ".webp",
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath);

    if (entry.isDirectory()) {
      if (
        ignoredDirectories.has(entry.name) ||
        ignoredPathParts.some((ignoredPath) =>
          relativePath.startsWith(ignoredPath),
        )
      ) {
        continue;
      }

      files.push(...(await walk(absolutePath)));
      continue;
    }

    if (
      !entry.isFile() ||
      ignoredFiles.has(entry.name) ||
      ignoredExtensions.has(path.extname(entry.name).toLowerCase())
    ) {
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

const violations = [];

for (const file of await walk(root)) {
  const content = await readFile(file, "utf8");
  const lines = content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;

  if (lines > maxLines) {
    violations.push({
      lines,
      path: path.relative(root, file),
    });
  }
}

if (violations.length > 0) {
  console.error(`Files over ${maxLines} LOC:`);

  for (const violation of violations.sort((a, b) => b.lines - a.lines)) {
    console.error(`${violation.lines.toString().padStart(5)} ${violation.path}`);
  }

  process.exit(1);
}

console.log(`All checked files are at or below ${maxLines} LOC.`);
