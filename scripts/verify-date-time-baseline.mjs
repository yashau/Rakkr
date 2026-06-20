import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/time/DATE_TIME_BASELINE.md";
const sourceFiles = [
  "apps/web/src/lib/dates.ts",
  "apps/web/src/lib/dates.test.ts",
  "apps/web/src/lib/schedule-draft.ts",
  "apps/web/src/lib/schedule-draft.test.ts",
  "apps/web/src/lib/recording-page-helpers.ts",
  "apps/api/src/schedule-engine.ts",
  "apps/api/test/schedule-engine.test.ts",
  "apps/api/test/schedule-runner.test.ts",
  "apps/api/src/recording-routes.ts",
  "apps/api/src/audit-routes.ts",
];
const requiredBaselinePhrases = [
  "UTC ISO 8601",
  "browser timezone",
  "year-first",
  "Local date filters",
  "datetime-local controls",
  "explicit timezone",
  "year-first `{{date}}`",
  "ad-hoc, recording-export, and audit-export filenames",
  "mise run time:check",
];
const requiredSourceSnippets = [
  "formatDateTime",
  "formatDate",
  "Intl.DateTimeFormat(undefined",
  "localDateBoundaryIso",
  "isoFromLocalDateTime",
  "localDateTimeInput",
  "recordedFrom: localDateBoundaryIso",
  "recordedTo: localDateBoundaryIso",
  "fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone",
  "titleTemplate: \"{{date}}_{{time}}_{{schedule.name}}_{{node.alias}}\"",
  "scheduleClock",
  "date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`",
  "time: `${pad(parts.hour)}${pad(parts.minute)}`",
  "localDateTimeToUtc",
  "schedule.timezone",
  "recordedAt: trackStart.toISOString()",
  "now.toISOString().slice(0, 16).replace(\"T\", \"_\")",
  "rakkr-recordings-${now.toISOString()",
  "rakkr-audit-events-${new Date().toISOString()",
];
const requiredTestSnippets = [
  "formats displayed dates year first in local browser time",
  "converts local date inputs to ISO UTC bounds",
  "round trips local datetime input controls through ISO timestamps",
  "computes local day starts without shifting display dates",
  "clamps monthly day schedules to shorter months",
  "2026-06-18_0900_Council Meeting",
];
const errors = [];

const baseline = await readFile(baselineFile, "utf8");
const sourceEntries = await Promise.all(
  sourceFiles.map(async (sourceFile) => ({
    content: await readFile(sourceFile, "utf8"),
    path: sourceFile,
  })),
);
const allSource = sourceEntries.map((entry) => entry.content).join("\n");
const allTests = sourceEntries
  .filter((entry) => entry.path.includes("/test/") || entry.path.endsWith(".test.ts"))
  .map((entry) => entry.content)
  .join("\n");

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing date/time evidence file ${sourceFile}`);
  }

  if (!baseline.includes(sourceFile)) {
    errors.push(`${baselineFile} should reference ${sourceFile}`);
  }
}

for (const phrase of requiredBaselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of requiredSourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`date/time source must include "${snippet}"`);
  }
}

for (const snippet of requiredTestSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`date/time tests must include "${snippet}"`);
  }
}

if (!/\breturn `\$\{parts\.year\}-\$\{parts\.month\}-\$\{parts\.day\} \$\{parts\.hour\}:\$\{parts\.minute\}`;/u.test(allSource)) {
  errors.push("formatDateTime must render a year-first browser-local date/time");
}

if (!/\breturn `\$\{parts\.year\}-\$\{parts\.month\}-\$\{parts\.day\}`;/u.test(allSource)) {
  errors.push("formatDate must render a year-first browser-local date");
}

if (errors.length > 0) {
  console.error(`Invalid date/time baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified date/time baseline in ${baselineFile}.`);
