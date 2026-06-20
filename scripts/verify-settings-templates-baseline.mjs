import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/settings/SETTINGS_TEMPLATES_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/index.ts",
  "packages/db/src/schema.ts",
  "apps/api/src/settings-routes.ts",
  "apps/api/src/settings-store.ts",
  "apps/api/src/recording-profile-settings.ts",
  "apps/api/test/settings-routes.test.ts",
  "apps/web/src/lib/settings-page-helpers.ts",
  "apps/web/src/lib/settings-page-helpers.test.ts",
  "apps/web/src/pages/settings.tsx",
  "apps/web/src/components/recording-profile-settings-card.tsx",
  "apps/web/src/components/watchdog-policy-card.tsx",
  "apps/api/src/recording-job-targets.ts",
  "apps/api/src/recording-jobs.ts",
  "apps/api/src/agent-routes.ts",
  "apps/api/test/agent-routes.test.ts",
  "crates/recorder-agent/src/channel_map.rs",
];
const baselinePhrases = [
  "checked partial baseline",
  "Recording profiles",
  "Watchdog policies",
  "Channel-map templates",
  "assigned to targets",
  "rolled back",
  "before/after snapshots",
  "settings:read",
  "settings:manage",
  "Postgres stores",
  "JSON fallback stores",
  "Bulk deployment",
  "Staged rollout",
  "mise run settings:check",
];
const sourceSnippets = [
  "recordingProfileUpdateSchema",
  "watchdogPolicyUpdateSchema",
  "channelMapTemplateInputSchema",
  "channelMapTemplateAssignmentInputSchema",
  "channelMapTemplateAssignmentRollbackInputSchema",
  "recordingProfiles",
  "watchdogPolicies",
  "channelMapTemplates",
  "templateAssignments",
  "createSettingsStore",
  "class JsonSettingsStore",
  "class PostgresSettingsStore",
  "nextChannelMapRevision",
  "rollbackChannelMapAssignment",
  "previousTemplateId",
  "settings.recording_profiles.update.succeeded",
  "settings.watchdog_policies.update.succeeded",
  "settings.channel_map_templates.create.succeeded",
  "settings.channel_map_templates.update.succeeded",
  "settings.channel_map_assignments.update.succeeded",
  "settings.channel_map_assignments.rollback.succeeded",
  "before: profileSnapshot(before)",
  "after: watchdogSnapshot(updated)",
  "canManageSettings",
  "canReadNodes",
  "api.channelMapAssignments",
  "api.rollbackChannelMapAssignment",
  "activeChannelMapSelection",
  "channelMapSelection(assignment, template)",
  "channelMap: recordingJobChannelMapSchema.optional()",
  "capture_channel_map_for_job",
  "pinned_job_channel_map_wins_over_live_assignments",
];
const testSnippets = [
  "settings write routes deny users without settings manage",
  "settings read routes deny users without settings read",
  "settings manage routes update operational templates and audit snapshots",
  "settings page permissions are closed by default",
  "settings page separates settings read manage and node lookup permissions",
  "capture_channel_map_for_job",
  "agent config read returns node recording capacity",
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
  .filter(
    (entry) =>
      entry.path.includes("/test/") ||
      entry.path.endsWith(".test.ts") ||
      entry.path === "crates/recorder-agent/src/channel_map.rs",
  )
  .map((entry) => entry.content)
  .join("\n");

for (const sourceFile of sourceFiles) {
  try {
    await access(sourceFile);
  } catch {
    errors.push(`missing settings/templates evidence file ${sourceFile}`);
  }

  if (!baseline.includes(sourceFile)) {
    errors.push(`${baselineFile} should reference ${sourceFile}`);
  }
}

for (const phrase of baselinePhrases) {
  if (!baseline.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(`${baselineFile} must mention "${phrase}"`);
  }
}

for (const snippet of sourceSnippets) {
  if (!allSource.includes(snippet)) {
    errors.push(`settings/templates source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`settings/templates tests must include "${snippet}"`);
  }
}

if (!allSource.includes('requirePermission("settings:read"')) {
  errors.push("settings read routes must be RBAC-gated");
}

if (!allSource.includes('requirePermission("settings:manage"')) {
  errors.push("settings manage routes must be RBAC-gated");
}

if (errors.length > 0) {
  console.error(`Invalid settings/templates baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified settings/templates baseline in ${baselineFile}.`);
