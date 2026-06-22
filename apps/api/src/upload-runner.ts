import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  HealthEvent,
  UploadQueueRunItem,
  UploadQueueRunSummary,
} from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import { deleteRecordingCacheFile } from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import type { UploadProviderStore } from "./upload-providers.js";
import { runUploadQueueOnce } from "./upload-executor.js";
import { uploadPolicyForQueue } from "./upload-policies.js";
import { listUploadQueueItems } from "./upload-queue.js";

interface UploadRunnerDependencies {
  auditStore: AuditStore;
  healthEventStore?: HealthEventStore;
  limit?: number;
  providerStore: UploadProviderStore;
  recordingIds?: ReadonlySet<string>;
  recordingStore?: RecordingStore;
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
    healthEventStore,
    limit = uploadRunnerBatchSize(),
    providerStore,
    recordingIds,
    recordingStore,
  }: UploadRunnerDependencies,
  now = new Date(),
) {
  const summary = await runUploadQueueOnce({ limit, now, providerStore, recordingIds });

  if (summary.attempted === 0) {
    return summary;
  }

  await appendUploadRunAudit(auditStore, summary, limit);

  for (const item of summary.items) {
    const retention = await applyUploadRetention(item, recordingStore);
    const healthEvent = await appendUploadFailureHealthEvent(
      healthEventStore,
      recordingStore,
      item,
    );

    await appendUploadItemAudit(auditStore, item, retention, healthEvent?.id);
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
  retention?: UploadRetentionResult,
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
      ...(retention ? { retention } : {}),
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

async function applyUploadRetention(
  item: UploadQueueRunItem,
  recordingStore?: RecordingStore,
): Promise<UploadRetentionResult | undefined> {
  if (item.status !== "succeeded" || !recordingStore) {
    return undefined;
  }

  if (item.provider === "stub") {
    return { skipped: "stub_provider" };
  }

  const queueItem = (await listUploadQueueItems()).find(
    (candidate) => candidate.id === item.itemId,
  );
  const policy = await uploadPolicyForQueue(queueItem?.uploadPolicyId);

  if (!policy.deleteCacheAfterUpload) {
    return { policyId: policy.id, skipped: "policy_keeps_cache" };
  }

  const recording = await recordingStore.find(item.recordingId);

  if (!recording?.cachePath) {
    return { policyId: policy.id, skipped: "recording_cache_missing" };
  }

  try {
    const cacheDeleted = await deleteRecordingCacheFile(recording);

    await recordingStore.save({
      ...recording,
      cachePath: undefined,
      cached: false,
      status: "uploaded",
    });

    return {
      cacheDeleted,
      policyId: policy.id,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "cache_retention_failed",
      policyId: policy.id,
    };
  }
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
