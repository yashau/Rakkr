import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/internal/baselines/RECORDING_LIBRARY_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/index.ts",
  "apps/api/src/recording-routes.ts",
  "apps/api/src/recording-listing.ts",
  "apps/api/src/recording-metadata.ts",
  "apps/api/src/recording-cache.ts",
  "apps/api/src/recording-delete.ts",
  "apps/api/src/recording-upload-queue-routes.ts",
  "apps/web/src/pages/recordings.tsx",
  "apps/web/src/components/recording-card.tsx",
  "apps/web/src/components/recording-bulk-organizer.tsx",
  "apps/web/src/components/recording-facet-panel.tsx",
  "apps/web/src/components/recording-upload-queue-summary.tsx",
  "apps/web/src/lib/recording-page-helpers.ts",
  "apps/api/test/recording-routes.test.ts",
  "apps/api/test/recording-route-permissions.test.ts",
  "apps/api/test/recording-cache.test.ts",
  "apps/api/test/recording-export-routes.test.ts",
  "apps/api/test/recording-metadata-routes.test.ts",
  "apps/api/test/recording-listing.test.ts",
  "apps/api/test/recording-upload-queue-routes.test.ts",
  "apps/api/test/agent-routes.test.ts",
  "apps/api/test/schedule-runner.test.ts",
  "apps/web/src/lib/recording-page-helpers.test.ts",
  "apps/api/test/recording-routes-metadata.test.ts",
  "apps/api/test/recording-routes-delete.test.ts",
  "apps/api/test/agent-routes-recording-lifecycle.test.ts",
];
const baselinePhrases = [
  "RBAC-gated",
  "audited",
  "Drizzle/Postgres",
  "JSON fallback",
  "search",
  "filters",
  "facets",
  "sorting",
  "pagination",
  "name, folder, tags, and notes",
  "bulk folder/tag organization",
  "node, schedule, recording profile, upload policy, track group",
  "playback",
  "download",
  "SHA-256",
  "waveform preview",
  "manifest export",
  "bulk upload queueing",
  "terminal-recording delete",
  "health timeline",
  "transcode derivatives are deferred",
  "mise run recordings:check",
];
const sourceSnippets = [
  "recordingMetadataUpdateSchema",
  "recordingBulkMetadataUpdateSchema",
  "recordingManifestCsv",
  "recordingFacets",
  "paginateRecordings",
  "recordingCacheState",
  "storeRecordingFile",
  "loadRecordingFile",
  "recordingHasCachedFile",
  "deleteRecording",
  "deleteRecordings",
  "recordings.playback.start",
  "recordings.download.prepare",
  "recordings.export_selected",
  "recordings.metadata.bulk_update",
  "recordings.bulk_delete",
  "recordings.upload_queue.bulk_enqueue",
  "recording:playback",
  "recording:download",
  "recording:delete",
  "waveformPreview",
  "checksum",
  "QualityTimeline",
  "RecordingBulkOrganizer",
  "RecordingFacetPanel",
  "RecordingUploadQueueSummary",
  "playbackPreviewFromSession",
  "downloadBlob",
  "recordingRelationshipBadges",
];
const testSnippets = [
  "recording facets summarize visible library relationships",
  "recording list filters by recorded date range",
  "recording list sorts by requested field and order",
  "recording list paginates sorted results",
  "recording list filters by profile upload policy and track group",
  "bulk metadata update organizes visible recordings and audits snapshots",
  "bulk recording delete removes terminal recordings and audits one snapshot",
  "recording delete removes terminal metadata cached file and audits snapshot",
  "recording routes deny users without required permissions",
  "stores checksum and wav waveform preview for cached recordings",
  "extracts duration and decoded waveform preview for encoded recordings",
  "recording export returns scoped filtered manifest and audits access",
  "selected recording export preserves requested order and audits selection",
  "recording metadata update saves and clears operator notes with audit snapshots",
  "recording listing filters cached and missing cache states",
  "single recording upload queue enqueues cached recordings after route extraction",
  "bulk upload queue enqueues visible cached recordings and audits collection",
  "ad hoc recording completes through agent cache attach and exposes cached media",
  "scheduled recording completes through agent cache attach and exposes schedule-owned media",
  "recording action helpers identify cached files for playback download and upload",
  "recording playback preview tracks session and file details",
  "recording page permissions mirror granular read and action grants",
  "recording relationship badges prefer permitted friendly reference names",
  "recording waveform helper clamps peak heights for stable previews",
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
    errors.push(`missing recording library evidence file ${sourceFile}`);
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
    errors.push(`recording library source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`recording library tests must include "${snippet}"`);
  }
}

if (/future preview\/transcode assets/iu.test(baseline)) {
  errors.push(`${baselineFile} should not list future transcode derivatives as MVP scope`);
}

if (errors.length > 0) {
  console.error(`Invalid recording library baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified recording library baseline in ${baselineFile}.`);
