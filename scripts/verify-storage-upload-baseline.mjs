import { access, readFile } from "node:fs/promises";

const baselineFile = "docs/internal/baselines/STORAGE_UPLOAD_BASELINE.md";
const sourceFiles = [
  "packages/shared/src/index.ts",
  "packages/shared/src/upload-providers.ts",
  "packages/db/src/schema.ts",
  "packages/db/drizzle/0022_bizarre_mastermind.sql",
  "packages/db/drizzle/0023_smiling_dragon_lord.sql",
  "packages/db/drizzle/0029_flowery_sheva_callister.sql",
  "packages/db/drizzle/0033_multiple_upload_destinations.sql",
  "apps/api/src/upload-executor.ts",
  "apps/api/src/upload-smb.ts",
  "apps/api/src/secret-box.ts",
  "apps/api/src/upload-destinations.ts",
  "apps/web/src/components/settings-upload-destinations-section.tsx",
  "apps/api/src/upload-policies.ts",
  "apps/api/src/upload-queue.ts",
  "apps/api/src/upload-runner.ts",
  "apps/api/src/upload-runner-routes.ts",
  "apps/api/src/recording-upload-queue-routes.ts",
  "apps/api/src/agent-routes.ts",
  "apps/api/src/metrics.ts",
  "apps/web/src/components/upload-policy-panel.tsx",
  "apps/web/src/components/upload-runner-panel.tsx",
  "apps/web/src/components/recording-upload-queue-summary.tsx",
  "apps/web/src/lib/upload-runner-panel-helpers.ts",
  "apps/api/test/upload-executor.test.ts",
  "apps/api/test/upload-runner.test.ts",
  "apps/api/test/upload-runner-routes.test.ts",
  "apps/api/test/upload-destinations.test.ts",
  "apps/api/test/upload-policies.test.ts",
  "apps/api/test/upload-queue.test.ts",
  "apps/api/test/agent-cache-idempotency-routes.test.ts",
  "apps/api/test/recording-upload-queue-routes.test.ts",
  "apps/api/test/settings-routes.test.ts",
  "apps/api/test/metrics.test.ts",
  "apps/api/test/agent-routes.test.ts",
  "apps/api/test/agent-routes-recording-lifecycle.test.ts",
  "apps/web/src/lib/upload-runner-panel-helpers.test.ts",
];
const baselinePhrases = [
  "Local recorder/controller cache remains the reliable source",
  "direct SMB and S3",
  "no OS mounts",
  "encrypted at rest",
  "RAKKR_SECRET_KEY",
  "SHA-256",
  "ChecksumSHA256",
  "Provider readiness",
  "retry budget",
  "cache-retention behavior",
  "on_recording_cached",
  "Replayed cache attach requests reuse",
  "controller crash/power-loss recovery makes stranded `retrying` items due again",
  "visible, filterable, retryable, audited, metric-exported, and resource-scoped",
  "run-now",
  "confirmed non-stub upload",
  "`settings:*` and `recording:*` RBAC",
  "Provider, policy, and queue persistence is Postgres-backed with JSON fallback",
  "multiple named SMB and S3 destinations",
  "fans out one upload queue item per",
  "partial",
  "subfolder override",
  "mise run storage:check",
];
const sourceSnippets = [
  "uploadDestinationSchema",
  "uploadDestinations",
  "upload_destinations",
  "uploadPolicies",
  "upload_policies",
  "uploadQueueItems",
  "upload_queue_items",
  "uploadQueueItemSchema",
  "uploadPolicySchema",
  "createUploadDestinationStore",
  "PostgresUploadDestinationStore",
  "uploadDestinationsTable",
  "PostgresUploadPolicyStore",
  "uploadPoliciesTable",
  "PostgresUploadQueueStore",
  "uploadQueueItemsTable",
  "onConflictDoUpdate",
  "uploadDestinationRuntimeStatus",
  "createUploadPolicy",
  "uploadPoliciesForCachedRecording",
  "uploadPolicyForCachedRecording",
  "uploadQueueInputForPolicy",
  "reconcileRecordingUpload",
  "destinationId",
  "pathOverride",
  "enqueueRecordingUpload",
  "reusableUploadQueueItem",
  "uploadLeaseExpiresAt",
  "RAKKR_UPLOAD_QUEUE_LEASE_SECONDS",
  "retryUploadQueueItem",
  "listDueUploadQueueItems",
  "runUploadQueueOnce",
  "uploadViaSmb",
  "smb3-client",
  "buildS3Client",
  "resolveConfig",
  "encryptSecret",
  "decryptSecret",
  "hasSmbPassword",
  "s3ProviderPresets",
  "forcePathStyle",
  "uploadToS3",
  "ChecksumSHA256",
  "source_checksum_mismatch",
  "createUploadRunner",
  "recordings.upload_queue.runner.completed",
  "recordings.upload_queue.runner_item.",
  "deleteCacheAfterUpload",
  "recordings.upload_runner.run.succeeded",
  "recordings.upload_runner.read",
  "recordings.upload_runner.run",
  "registerRecordingUploadQueueRoutes",
  "recordings.upload_queue.bulk_enqueue",
  "recordings.upload_queue.retry",
  "rakkr_upload_queue_depth",
  "rakkr_upload_queue_oldest_due_seconds",
  "rakkr_upload_failures_total",
  "UploadPolicyEditor",
  "UploadRunnerPanel",
  "RecordingUploadQueueSummary",
  "uploadRunnerPanelPermissions",
  "Delete controller cache after confirmed upload",
];
const testSnippets = [
  "runs due stub upload queue items to success",
  "defers provider failures until the retry budget is exhausted",
  "uploads SMB queue items directly to the share over the network",
  "uploads S3 queue items with explicit credentials, bucket, key, and metadata",
  "fails real provider upload when cached file checksum disagrees with metadata",
  "upload runner processes queue items and records service audit events",
  "upload runner deletes local cache after confirmed upload when policy requests it",
  "upload runner marks recordings partial when one destination fails",
  "upload runner routes expose status and run-now control",
  "upload runner routes deny users without required permissions",
  "reports upload destination configuration readiness",
  "creates and updates upload policy templates",
  "operator retry resets a terminally-failed stub upload to a fresh retrying attempt",
  "leases started upload queue items until crash recovery makes them due again",
  "reuses succeeded upload queue item for the same cached artifact",
  "skips in-flight upload items until their recovery lease expires",
  "duplicate cache attach after upload success reuses existing upload queue item",
  "single recording upload queue enqueues cached recordings after route extraction",
  "bulk upload queue enqueues visible cached recordings and audits collection",
  "upload queue list filters visible items by status provider and recording",
  "upload queue retry audits items outside scoped visibility",
  "settings write routes deny users without settings manage",
  "settings read routes deny users without settings read",
  "rakkr_upload_queue_depth",
  "rakkr_upload_queue_oldest_due_seconds",
  "rakkr_upload_failures_total",
  "recordings.upload_queue.auto_enqueue.succeeded",
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
    errors.push(`missing storage upload evidence file ${sourceFile}`);
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
    errors.push(`storage upload source must include "${snippet}"`);
  }
}

for (const snippet of testSnippets) {
  if (!allTests.includes(snippet)) {
    errors.push(`storage upload tests must include "${snippet}"`);
  }
}

if (errors.length > 0) {
  console.error(`Invalid storage upload baseline in ${baselineFile}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Verified storage upload baseline in ${baselineFile}.`);
