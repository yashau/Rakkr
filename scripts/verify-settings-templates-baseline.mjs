import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/internal/baselines/SETTINGS_TEMPLATES_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/index.ts",
  "packages/db/src/schema.ts",
  "apps/api/src/settings-routes.ts",
  "apps/api/src/settings-controller-routes.ts",
  "apps/api/src/controller-settings-store.ts",
  "apps/api/src/channel-map-assignment-plans.ts",
  "apps/api/src/settings-store.ts",
  "apps/api/src/recording-profile-settings.ts",
  "apps/api/src/retention-policies.ts",
  "apps/api/src/retention-policy-routes.ts",
  "apps/api/src/retention-runner.ts",
  "apps/api/src/api-runners.ts",
  "apps/api/src/agent-node-config-route.ts",
  "apps/api/src/schedule-engine.ts",
  "apps/api/src/schedule-store.ts",
  "apps/api/test/schedule-routes.test.ts",
  "apps/api/test/schedule-runner.test.ts",
  "apps/web/src/lib/schedule-draft.ts",
  "apps/api/src/upload-policies.ts",
  "apps/api/src/upload-runner.ts",
  "apps/api/test/retention-policy-routes.test.ts",
  "apps/api/test/retention-runner.test.ts",
  "apps/api/test/settings-routes.test.ts",
  "apps/api/test/settings-controller-routes.test.ts",
  "apps/api/test/upload-policies.test.ts",
  "apps/api/test/upload-runner.test.ts",
  "apps/web/src/lib/settings-page-helpers.ts",
  "apps/web/src/lib/settings-page-helpers.test.ts",
  "apps/web/src/pages/settings.tsx",
  "apps/web/src/components/settings-recording-profiles-section.tsx",
  "apps/web/src/components/settings-watchdog-policies-section.tsx",
  "apps/web/src/components/settings-upload-destinations-section.tsx",
  "apps/web/src/components/settings-upload-policies-section.tsx",
  "apps/web/src/components/settings-retention-policies-section.tsx",
  "apps/web/src/components/settings-channel-maps-section.tsx",
  "apps/web/src/components/channel-map-template-card.tsx",
  "apps/web/src/components/retention-policy-panel.tsx",
  "apps/web/src/components/upload-policy-panel.tsx",
  "apps/web/src/components/recording-profile-settings-card.tsx",
  "apps/web/src/components/watchdog-policy-card.tsx",
  "apps/web/src/lib/settings-updates.ts",
  "apps/web/src/lib/settings-updates.test.ts",
  "apps/api/src/recording-job-targets.ts",
  "apps/api/src/recording-jobs.ts",
  "apps/api/src/agent-routes.ts",
  "apps/api/test/agent-routes.test.ts",
  "crates/recorder-agent/src/channel_map.rs",
  "crates/recorder-agent/src/controller.rs",
  "crates/recorder-agent/src/main.rs",
  "crates/recorder-agent/src/node_config.rs",
  "crates/recorder-agent/src/recording_job_recovery.rs",
  "crates/recorder-agent/src/recorder_cache_retention.rs",
  "crates/recorder-agent/src/system_health.rs",
  "scripts/agent-fake-controller-smoke.mjs",
  "scripts/agent-fake-controller-smoke-support.mjs",
];
const baselinePhrases = [
  "checked baseline",
  "Recording profiles",
  "Controller display name",
  "Rakkr Controller",
  "Watchdog policies",
  "quality anomaly",
  "broadband-noise",
  "flatline controls",
  "Channel-map templates",
  "bulk-assigned",
  "assigned to targets",
  "rolled back",
  "before/after snapshots",
  "settings:read",
  "settings:manage",
  "Postgres stores",
  "JSON fallback stores",
  "Bulk deployment",
  "Staged rollout",
  "explicit apply step",
  "cache-retention behavior",
  "upload-policy cache retention",
  "Retention policy templates",
  "retention runner",
  "retentionPolicyId",
  "max-age",
  "max-bytes",
  "Recorder-cache delete-after-upload",
  "delete-failure reporting",
  "Recorder-cache max-age and max-bytes sweep",
  "Recorder-cache min-free-disk sweep",
  "system disk pressure",
  "mise run settings:check",
];
const sourceSnippets = [
  "recordingProfileUpdateSchema",
  "controllerSettingsSchema",
  "controllerSettingsUpdateSchema",
  "defaultControllerSettings",
  "controller_settings",
  "createControllerSettingsStore",
  "settings.controller.read",
  "settings.controller.update.succeeded",
  "api.updateControllerSettings",
  "watchdogPolicyUpdateSchema",
  "flatlineMode",
  "flatlineThresholdDbfs",
  "minCumulativeFlatlineSeconds",
  "qualityAlertMode",
  "broadbandNoiseScoreThreshold",
  "noiseScoreThreshold",
  "humScoreThreshold",
  "staticScoreThreshold",
  "minCumulativeQualitySeconds",
  "channelMapTemplateInputSchema",
  "channelMapTemplateAssignmentBulkInputSchema",
  "channelMapAssignmentPlanInputSchema",
  "channelMapAssignmentPlanSchema",
  "channelMapTemplateAssignmentInputSchema",
  "channelMapTemplateAssignmentRollbackInputSchema",
  "recordingProfiles",
  "retentionPolicyInputSchema",
  "retentionPolicyUpdateSchema",
  "retentionPolicySchema",
  "retentionPolicyId",
  "retention_policy_id",
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
  "settings.channel_map_assignments.bulk_update.succeeded",
  "settings.channel_map_assignment_plans.create.succeeded",
  "settings.channel_map_assignment_plans.apply.succeeded",
  "settings.channel_map_assignments.update.succeeded",
  "settings.channel_map_assignments.rollback.succeeded",
  "settings.retention_policies.create.succeeded",
  "settings.retention_policies.update.succeeded",
  "createRetentionRunner",
  "runRetentionPass",
  "recordings.retention.cache_deleted",
  "recordings.retention.runner.completed",
  "RAKKR_RETENTION_RUNNER_ENABLED",
  "recording.retentionPolicyId !== policy.id",
  "recorderCacheRetention",
  "recorder_cache_retention",
  "apply_recorder_cache_retention",
  "delete_recorder_cache_files",
  "record_uploaded_cache_files",
  "recorderCachePolicies",
  "run_recorder_cache_sweep",
  "RecorderCacheDiskUsage",
  "min_free_disk",
  "disk_usage",
  "agent.recorder_cache.sweep_completed",
  "agent.recording_job.recorder_cache_deleted",
  "agent.recording_job.recorder_cache_delete_failed",
  "reports_cache_delete_failures",
  "deleteCacheAfterUpload",
  "reconcileRecordingUpload",
  "Delete controller cache after confirmed upload",
  "before: profileSnapshot(before)",
  "after: watchdogSnapshot(updated)",
  "canManageSettings",
  "canReadNodes",
  "api.channelMapAssignments",
  "api.bulkAssignChannelMapTemplate",
  "api.createChannelMapAssignmentPlan",
  "api.applyChannelMapAssignmentPlan",
  "api.createRetentionPolicy",
  "api.retentionPolicies",
  "api.updateRetentionPolicy",
  "api.rollbackChannelMapAssignment",
  "Assign Selected",
  "Retention Policies",
  "Stage Plan",
  "Apply",
  "activeChannelMapSelection",
  "channelMapSelection(assignment, template)",
  "channelMap: recordingJobChannelMapSchema.optional()",
  "capture_channel_map_for_job",
  "pinned_job_channel_map_wins_over_live_assignments",
];
const testSnippets = [
  "controller settings read and update persist and audit",
  "controller settings deny without settings read and manage",
  "settings write routes deny users without settings manage",
  "settings read routes deny users without settings read",
  "settings manage routes update operational templates and audit snapshots",
  "watchdog policy update preserves quality and flatline fields",
  "settings.channel_map_assignments.bulk_update.succeeded",
  "settings.channel_map_assignment_plans.create.succeeded",
  "settings.channel_map_assignment_plans.apply.succeeded",
  "retention policy routes deny users without settings permissions",
  "retention policy routes create update and audit snapshots",
  "retention runner deletes stale controller cache and audits the lifecycle",
  "retention runner trims oldest uploaded cache when max bytes is exceeded",
  "retentionPolicyId",
  "agent config read returns node recording capacity and recorder-cache policies",
  "recording job carries recorder-cache retention policy",
  "agent.recorder_cache.sweep_completed",
  "min-free recorder-cache sweep did not delete files",
  "agent.recording_job.recorder_cache_deleted",
  "creates and updates upload policy templates",
  "upload runner deletes local cache after confirmed upload when policy requests it",
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
      entry.path === "crates/recorder-agent/src/channel_map.rs" ||
      entry.path === "scripts/agent-fake-controller-smoke.mjs",
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
