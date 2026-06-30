import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  HealthEvent,
  RecordingSummary,
  UploadQueueItem,
  UploadQueueRunItem,
  UploadQueueRunSummary,
} from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import { deleteRecordingCacheFile } from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import type { UploadDestinationStore } from "./upload-destinations.js";
import { runUploadQueueOnce } from "./upload-executor.js";
import { uploadPolicyForQueue } from "./upload-policies.js";
import { listUploadQueueItems } from "./upload-queue.js";
import type { SmbClientFactory } from "./upload-smb.js";

interface UploadRunnerDependencies {
  auditStore: AuditStore;
  destinationStore: UploadDestinationStore;
  healthEventStore?: HealthEventStore;
  limit?: number;
  recordingIds?: ReadonlySet<string>;
  recordingStore?: RecordingStore;
  // Test-only override so SMB uploads can be exercised without a live server.
  smbClientFactory?: SmbClientFactory;
}

export interface UploadRunnerRunOptions {
  recordingIds?: ReadonlySet<string>;
}

interface UploadRetentionResult {
  cacheDeleted?: boolean;
  error?: string;
  policyId?: string;
  skipped?: string;
}

export function createUploadRunner(dependencies: UploadRunnerDependencies) {
  const batchSize = dependencies.limit ?? uploadRunnerBatchSize();
  let intervalMs = uploadRunnerIntervalMs();
  let lastRunAt: string | undefined;
  let lastSummary: UploadQueueRunSummary | undefined;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(now = new Date(), options: UploadRunnerRunOptions = {}) {
    if (running) {
      return emptySummary();
    }

    running = true;

    try {
      const summary = await runUploadQueuePass(
        {
          ...dependencies,
          limit: batchSize,
          recordingIds: options.recordingIds ?? dependencies.recordingIds,
        },
        now,
      );

      lastRunAt = new Date().toISOString();
      lastSummary = summary;

      return summary;
    } finally {
      running = false;
    }
  }

  return {
    async runOnce(now = new Date(), options: UploadRunnerRunOptions = {}) {
      return tick(now, options);
    },
    start(nextIntervalMs = uploadRunnerIntervalMs()) {
      if (timer) {
        return;
      }

      intervalMs = nextIntervalMs;
      timer = setInterval(() => {
        void tick();
      }, nextIntervalMs);
      void tick();
    },
    status() {
      return {
        batchSize,
        intervalSeconds: Math.max(1, Math.round(intervalMs / 1_000)),
        lastRunAt,
        lastSummary,
        running,
        started: Boolean(timer),
      };
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export type UploadRunner = ReturnType<typeof createUploadRunner>;

export async function runUploadQueuePass(
  {
    auditStore,
    destinationStore,
    healthEventStore,
    limit = uploadRunnerBatchSize(),
    recordingIds,
    recordingStore,
    smbClientFactory,
  }: UploadRunnerDependencies,
  now = new Date(),
) {
  const summary = await runUploadQueueOnce({
    destinationStore,
    limit,
    now,
    recordingIds,
    smbClientFactory,
  });

  if (summary.attempted === 0) {
    return summary;
  }

  await appendUploadRunAudit(auditStore, summary, limit);

  for (const item of summary.items) {
    const healthEvent = await appendUploadFailureHealthEvent(
      healthEventStore,
      recordingStore,
      item,
    );

    await appendUploadItemAudit(auditStore, item, healthEvent?.id);
  }

  // Reconcile each affected recording once all its upload items have settled:
  // derive uploaded/partial status and run the gated cache deletion.
  const touchedRecordingIds = [...new Set(summary.items.map((item) => item.recordingId))];

  for (const recordingId of touchedRecordingIds) {
    await reconcileRecordingUpload(recordingId, recordingStore, auditStore);
  }

  return summary;
}

async function appendUploadRunAudit(
  auditStore: AuditStore,
  summary: UploadQueueRunSummary,
  limit: number,
) {
  await auditStore.append({
    action: "recordings.upload_queue.runner.completed",
    actor: uploadRunnerActor(),
    actorContext: {},
    correlationIds: uploadRunCorrelationIds(summary),
    createdAt: new Date().toISOString(),
    details: {
      attempted: summary.attempted,
      deferred: summary.deferred,
      failed: summary.failed,
      limit,
      succeeded: summary.succeeded,
    },
    id: `audit_${randomUUID()}`,
    outcome: uploadRunOutcome(summary),
    permission: "recording:control",
    target: {
      type: "upload_queue",
    },
  });
}

async function appendUploadItemAudit(
  auditStore: AuditStore,
  item: UploadQueueRunItem,
  healthEventId?: string,
) {
  const outcome = uploadItemOutcome(item);

  await auditStore.append({
    action: `recordings.upload_queue.runner_item.${outcome}`,
    actor: uploadRunnerActor(),
    actorContext: {},
    correlationIds: {
      recordingId: item.recordingId,
      uploadQueueItemId: item.itemId,
    },
    createdAt: new Date().toISOString(),
    details: {
      ...(item.checksumVerification ? { checksumVerification: item.checksumVerification } : {}),
      ...(healthEventId ? { healthEventId } : {}),
      provider: item.provider,
      status: item.status,
    },
    id: `audit_${randomUUID()}`,
    outcome: outcome === "deferred" ? "partial" : outcome,
    permission: "recording:control",
    reason: item.reason,
    target: {
      id: item.recordingId,
      type: "recording",
    },
  });
}

async function appendUploadFailureHealthEvent(
  healthEventStore: HealthEventStore | undefined,
  recordingStore: RecordingStore | undefined,
  item: UploadQueueRunItem,
): Promise<HealthEvent | undefined> {
  if (!healthEventStore || item.status !== "failed") {
    return undefined;
  }

  const event = await healthEventStore.create({
    details: {
      provider: item.provider,
      reason: item.reason ?? "upload_failed",
      source: "upload_runner",
      uploadQueueItemId: item.itemId,
    },
    recordingId: item.recordingId,
    severity: "warning",
    type: "controller.recording.upload_queue_failed",
  });

  if (recordingStore) {
    await syncRecordingHealth(healthEventStore, recordingStore, item.recordingId);
  }

  return event;
}

// Recording-level reconciliation: once every non-stub upload item for a recording
// is terminal, derive its overall status (uploaded/partial) and run the gated
// cache deletion. Independent destinations never block one another; a single
// destination failure yields `partial` rather than failing the recording.
async function reconcileRecordingUpload(
  recordingId: string,
  recordingStore: RecordingStore | undefined,
  auditStore: AuditStore,
): Promise<void> {
  if (!recordingStore) {
    return;
  }

  const recording = await recordingStore.find(recordingId);

  if (!recording) {
    return;
  }

  const items = (await listUploadQueueItems()).filter(
    (item) => item.recordingId === recordingId && item.provider !== "stub",
  );

  if (items.length === 0) {
    return;
  }

  // Wait until every destination has reached a terminal state.
  if (items.some((item) => item.status !== "succeeded" && item.status !== "failed")) {
    return;
  }

  const succeeded = items.filter((item) => item.status === "succeeded");
  const failed = items.filter((item) => item.status === "failed");

  // All destinations failed: leave the recording cached; failures already raised
  // per-item health events and remain retryable.
  if (succeeded.length === 0) {
    return;
  }

  const status: RecordingSummary["status"] = failed.length > 0 ? "partial" : "uploaded";
  const retention = await resolveCacheDeletion(succeeded, recording);
  const cacheDeleted = retention.cacheDeleted === true;

  await recordingStore.save({
    ...recording,
    ...(cacheDeleted ? { cachePath: undefined, cached: false } : {}),
    status,
  });

  await appendReconcileAudit(
    auditStore,
    recording,
    status,
    succeeded.length,
    failed.length,
    retention,
  );
}

// Cache-deletion gate: only delete the shared cache file when all items are
// terminal (guaranteed by the caller) and a succeeded destination's policy asks
// for it — so a still-pending destination never loses the source file.
async function resolveCacheDeletion(
  succeededItems: UploadQueueItem[],
  recording: RecordingSummary,
): Promise<UploadRetentionResult> {
  if (!recording.cachePath) {
    return { skipped: "recording_cache_missing" };
  }

  for (const item of succeededItems) {
    const policy = await uploadPolicyForQueue(item.uploadPolicyId);

    if (policy.deleteCacheAfterUpload) {
      try {
        const cacheDeleted = await deleteRecordingCacheFile(recording);

        return { cacheDeleted, policyId: policy.id };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "cache_retention_failed",
          policyId: policy.id,
        };
      }
    }
  }

  return { skipped: "policy_keeps_cache" };
}

async function appendReconcileAudit(
  auditStore: AuditStore,
  recording: RecordingSummary,
  status: RecordingSummary["status"],
  succeeded: number,
  failed: number,
  retention: UploadRetentionResult,
) {
  await auditStore.append({
    action: `recordings.upload_queue.reconciled.${status === "uploaded" ? "succeeded" : "partial"}`,
    actor: uploadRunnerActor(),
    actorContext: {},
    correlationIds: { recordingId: recording.id },
    createdAt: new Date().toISOString(),
    details: {
      failed,
      retention,
      status,
      succeeded,
    },
    id: `audit_${randomUUID()}`,
    outcome: status === "uploaded" ? "succeeded" : "partial",
    permission: "recording:control",
    target: {
      id: recording.id,
      name: recording.name,
      type: "recording",
    },
  });
}

function uploadRunOutcome(summary: UploadQueueRunSummary): AuditEvent["outcome"] {
  if (summary.failed > 0 && summary.succeeded === 0 && summary.deferred === 0) {
    return "failed";
  }

  return summary.failed > 0 || summary.deferred > 0 ? "partial" : "succeeded";
}

function uploadItemOutcome(item: UploadQueueRunItem) {
  if (item.status === "succeeded") {
    return "succeeded";
  }

  return item.status === "failed" ? "failed" : "deferred";
}

function uploadRunCorrelationIds(summary: UploadQueueRunSummary) {
  const firstItem = summary.items[0];

  return firstItem
    ? {
        recordingId: firstItem.recordingId,
        uploadQueueItemId: firstItem.itemId,
      }
    : undefined;
}

function uploadRunnerActor(): AuditEvent["actor"] {
  return {
    id: "system:upload-runner",
    name: "Rakkr Upload Runner",
    roles: [],
    type: "system",
  };
}

function emptySummary(): UploadQueueRunSummary {
  return {
    attempted: 0,
    deferred: 0,
    failed: 0,
    items: [],
    succeeded: 0,
  };
}

function uploadRunnerIntervalMs() {
  return positiveInteger(process.env.RAKKR_UPLOAD_RUNNER_INTERVAL_SECONDS, 60) * 1_000;
}

function uploadRunnerBatchSize() {
  return positiveInteger(process.env.RAKKR_UPLOAD_RUNNER_BATCH_SIZE, 10);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
