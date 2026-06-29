import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/internal/baselines/OPERATIONS_BASELINE.md";
const sourceFiles = [
  "docs/internal/baselines/RECORDING_LIBRARY_BASELINE.md",
  "docs/internal/baselines/STORAGE_UPLOAD_BASELINE.md",
  "packages/shared/src/index.ts",
  "apps/api/src/recording-routes.ts",
  "apps/api/src/recording-listing.ts",
  "apps/api/src/recording-metadata.ts",
  "apps/api/src/audit-routes.ts",
  "apps/api/src/audit-store.ts",
  "apps/api/src/settings-routes.ts",
  "apps/api/src/settings-store.ts",
  "apps/api/src/upload-policies.ts",
  "apps/api/src/upload-providers.ts",
  "apps/api/src/upload-runner.ts",
  "apps/api/src/recording-upload-queue-routes.ts",
  "apps/web/src/pages/audit.tsx",
  "apps/web/src/pages/recordings.tsx",
  "apps/web/src/pages/settings.tsx",
  "apps/web/src/components/recording-bulk-organizer.tsx",
  "apps/web/src/components/recording-facet-panel.tsx",
  "apps/web/src/components/recording-profile-settings-card.tsx",
  "apps/web/src/components/upload-policy-panel.tsx",
  "apps/web/src/components/upload-runner-panel.tsx",
  "apps/api/test/recording-routes.test.ts",
  "apps/api/test/recording-export-routes.test.ts",
  "apps/api/test/recording-metadata-routes.test.ts",
  "apps/api/test/settings-routes.test.ts",
  "apps/api/test/audit-routes.test.ts",
  "apps/api/test/upload-policies.test.ts",
  "apps/api/test/upload-providers.test.ts",
  "apps/api/test/upload-runner.test.ts",
  "apps/api/test/recording-upload-queue-routes.test.ts",
  "apps/web/src/lib/recording-page-helpers.test.ts",
  "apps/web/src/lib/settings-page-helpers.test.ts",
  "apps/web/src/lib/audit-page-helpers.test.ts",
  "apps/web/src/lib/upload-runner-panel-helpers.test.ts",
];
const baselinePhrases = [
  "MVP baseline checked",
  "Recording organization",
  "search, facets, filters",
  "folder/tag edits",
  "operator notes",
  "manifest CSV export",
  "recording profiles",
  "watchdog policies",
  "upload providers",
  "upload policies",
  "channel map templates",
  "channel map assignments",
  "revision promotion",
  "rollback",
  "RBAC-gated",
  "before/after snapshots",
  "filtered search",
  "CSV export",
  "stub, mounted-share SMB, and S3",
  "provider readiness",
  "policy templates",
  "auto/manual queueing",
  "run-now",
  "controller-local",
  "mise run operations:check",
];
const sourceSnippets = [
  "recordingFacets",
  "recordingManifestCsv",
  "recordings.metadata.bulk_update",
  "recordings.export.succeeded",
  "recordings.export_selected.succeeded",
  "registerAuditRoutes",
  "auditEventsCsv",
  "audit.events.export",
  "auditConditions",
  "registerSettingsRoutes",
  "settings.recording_profiles.update.succeeded",
  "settings.watchdog_policies.update.succeeded",
  "settings.upload_providers.update.succeeded",
  "settings.upload_policies.create.succeeded",
  "settings.upload_policies.update.succeeded",
  "settings.channel_map_templates.create.succeeded",
  "settings.channel_map_templates.update.succeeded",
  "settings.channel_map_assignments.update.succeeded",
  "settings.channel_map_assignments.rollback.succeeded",
  "PostgresSettingsStore",
  "JsonSettingsStore",
  "createChannelMapTemplate",
  "rollbackChannelMapAssignment",
  "createUploadPolicy",
  "uploadPolicyForCachedRecording",
  "uploadProviderRuntimeStatus",
  "runUploadQueueOnce",
  "recordings.upload_runner.run.succeeded",
  "recordings.upload_queue.bulk_enqueue",
  "RecordingBulkOrganizer",
  "RecordingFacetPanel",
  "RecordingProfileSettingsCard",
  "UploadPolicyEditor",
  "UploadRunnerPanel",
  "auditEventsExport",
  "settingsPagePermissions",
];
const testSnippets = [
  "recording facets summarize visible library relationships",
  "bulk metadata update organizes visible recordings and audits snapshots",
  "recording export returns scoped filtered manifest and audits access",
  "recording metadata update saves and clears operator notes with audit snapshots",
  "settings manage routes update operational templates and audit snapshots",
  "settings write routes deny users without settings manage",
  "settings read routes deny users without settings read",
  "audit routes list events with filters",
  "audit routes export filtered events as csv",
  "creates and updates upload policy templates",
  "reports upload provider configuration readiness",
  "upload runner processes queue items and records service audit events",
  "bulk upload queue enqueues visible cached recordings and audits collection",
  "recording page permissions mirror granular read and action grants",
  "settings page separates settings read manage and node lookup permissions",
  "audit page read and export require audit read permission",
  "upload runner panel separates status read from run control",
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
    errors.push(`missing operations evidence file ${sourceFile}`);
  }

  if (sourceFile.includes(".test.") && !baseline.includes(sourceFile)) {
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
    errors.push(`operations source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`operations tests must include "${snippet}"`);
  }
}

if (/real test-rig validation[^.]*complete/iu.test(baseline)) {
  errors.push(`${baselineFile} must not claim real test-rig validation is complete`);
}

if (errors.length > 0) {
  console.error(`Invalid operations baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified operations baseline in ${baselineFile}.`);
