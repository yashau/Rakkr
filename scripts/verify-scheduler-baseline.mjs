import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/internal/baselines/SCHEDULER_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/index.ts",
  "packages/db/src/schema.ts",
  "packages/db/drizzle/0021_true_midnight.sql",
  "apps/api/src/schedule-engine.ts",
  "apps/api/src/schedule-routes.ts",
  "apps/api/src/schedule-store.ts",
  "apps/api/src/schedule-runner.ts",
  "apps/api/src/scheduled-recordings.ts",
  "apps/web/src/lib/schedule-draft.ts",
  "apps/api/test/schedule-engine.test.ts",
  "apps/api/test/schedule-runner.test.ts",
  "apps/api/test/schedule-routes.test.ts",
  "apps/web/src/lib/schedule-page-helpers.test.ts",
  "apps/web/src/lib/schedule-detail-page-helpers.test.ts",
  "apps/web/src/lib/schedule-draft.test.ts",
];
const recurrenceModes = ["manual", "once", "daily", "weekly", "monthly", "always_on"];
const baselinePhrases = [
  "Human-friendly",
  "no cron language",
  "interval spacing",
  "explicit timezone",
  "Start-early",
  "stop-late",
  "Skip-next",
  "pause ranges",
  "schedule-owned recordings",
  "optional capture backend/interface selection",
  "retention policy",
  "system:scheduler",
  "RBAC-gated",
  "create, update, run-now, and skip-next actions are audited",
  "mise run scheduler:check",
];
const sourceSnippets = [
  "scheduleRecurrenceSchema",
  "previewScheduleOccurrences",
  "skipNextScheduleOccurrence",
  "scheduleRecordingTrackPlans",
  "materializeScheduledRecording",
  "retentionPolicyId",
  "captureBackend",
  "captureInterfaceId",
  "retention_policy_id",
  "capture_backend",
  "capture_interface_id",
  "queueScheduledRecordings",
  "schedules.run_now",
  "schedules.skip_next",
  "schedules.create.succeeded",
  "schedules.update.succeeded",
  "schedules.run_now.succeeded",
  "schedules.skip_next.succeeded",
  "schedules.due_run.succeeded",
  "schedule:read",
  "schedule:manage",
  "applyNaturalLanguageSchedule",
];
const testSnippets = [
  "previews weekly interval windows with start-early and stop-late buffers",
  "skips one-off exceptions and paused local date ranges",
  "clamps monthly day schedules to shorter months",
  "splits scheduled recording windows by profile track length",
  "scheduled recording completes through agent cache attach and exposes schedule-owned media",
  "due schedule creates ordered track jobs when profile has max track length",
  "captureBackend",
  "captureInterfaceId",
  "retentionPolicyId",
  "schedule routes deny users without required permissions",
  "schedule routes create update run-now and skip-next with audit events",
  "schedule quick phrases produce structured weekly recurrence",
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
    errors.push(`missing scheduler evidence file ${sourceFile}`);
  }

  if (sourceFile.includes(".test.") && !baseline.includes(sourceFile)) {
    errors.push(`${baselineFile} should reference ${sourceFile}`);
  }
}

for (const mode of recurrenceModes) {
  if (!baseline.includes(mode === "once" ? "one-off" : mode.replace("_", "-"))) {
    errors.push(`${baselineFile} must document recurrence mode ${mode}`);
  }

  if (!allSource.includes(`"${mode}"`)) {
    errors.push(`scheduler source does not reference recurrence mode ${mode}`);
  }
}

for (const phrase of baselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of sourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`scheduler source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`scheduler tests must include "${snippet}"`);
  }
}

for (const entry of sourceEntries.filter((entry) => !entry.path.startsWith("docs/"))) {
  if (/\bcron\b/iu.test(entry.content)) {
    errors.push(`${entry.path} should not expose cron language`);
  }
}

if (errors.length > 0) {
  console.error(`Invalid scheduler baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified scheduler baseline in ${baselineFile}.`);
