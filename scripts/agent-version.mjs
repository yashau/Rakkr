import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = path.join(root, "crates", "recorder-agent", "VERSION");
const relativeVersionFile = path.relative(root, versionFile);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const version = (await readFile(versionFile, "utf8")).trim();
const match = /^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/.exec(version);

if (!match) {
  fail(
    `Recorder-agent version "${version}" in ${relativeVersionFile} must be YYYY.MM.DD-N.`,
  );
}

const [, , month, day, counter] = match;

if (Number(month) < 1 || Number(month) > 12) {
  fail(`Recorder-agent version "${version}" has an out-of-range month.`);
}

if (Number(day) < 1 || Number(day) > 31) {
  fail(`Recorder-agent version "${version}" has an out-of-range day.`);
}

if (Number(counter) < 1) {
  fail(`Recorder-agent version "${version}" must use a same-day counter of 1 or greater.`);
}

process.stdout.write(`${version}\n`);
