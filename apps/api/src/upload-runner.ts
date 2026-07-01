import { randomUUID } from "node:crypto";
import { reportRunnerTickError } from "./runner-tick.js";
import type {
  AuditEvent,
  HealthEvent,
  RecordingChunk,
  RecordingChunkStatus,
  RecordingSummary,
  UploadQueueItem,
  UploadQueueRunItem,
  UploadQueueRunSummary,
} from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import { deleteRecordingCacheFile, deleteRecordingChunkCacheFile } from "./recording-cache.js";
import { listRecordingChunksForRecording, upsertRecordingChunk } from "./recording-chunks.js";
import { recordingJob } from "./recording-jobs.js";
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
        void tick().catch(reportRunnerTickError("upload runner"));
      }, nextIntervalMs);
      void tick().catch(reportRunnerTickError("upload runner"));
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

  // Chunked recordings reconcile per chunk (each chunk uploads as its own object);
  // the recording is promoted to uploaded/partial from the chunk states.
  const chunkItems = items.filter((item) => item.chunkId);

  if (chunkItems.length > 0) {
    await reconcileChunkedRecordingUpload(recording, chunkItems, recordingStore, auditStore);
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

  // Re-read immediately before promoting: a concurrent retry (which resets the
  // recording to `recording`/`queued`) or a terminal-failed decision must not be
  // overwritten by a stale reconcile from earlier-enqueued upload items.
  const current = await reconcilableRecording(recording, recordingStore);

  if (!current) {
    return;
  }

  const status: RecordingSummary["status"] = failed.length > 0 ? "partial" : "uploaded";
  // Only release the shared controller cache once EVERY destination is
  // confirmed. A partial upload still has retryable failed destinations whose
  // only source is this cache file, so deleting it now would strand them
  // permanently (their retry would fail with cache_path_missing forever).
  const retention =
    failed.length > 0
      ? ({ skipped: "upload_incomplete" } satisfies UploadRetentionResult)
      : await resolveCacheDeletion(succeeded, current);
  const cacheDeleted = retention.cacheDeleted === true;

  await recordingStore.save({
    ...current,
    ...(cacheDeleted ? { cachePath: undefined, cached: false } : {}),
    status,
  });

  await appendReconcileAudit(
    auditStore,
    current,
    status,
    succeeded.length,
    failed.length,
    retention,
  );
}

// Recording statuses a reconcile pass may legitimately promote from. A recording
// a concurrent retry reset to `recording`/`queued`, or that another writer set
// terminal (`failed`/`completed`), has moved on — a stale reconcile built from
// earlier-enqueued upload items must not overwrite it. (Recording status has no
// compare-and-set, so this re-read narrows the window; a full recording-status
// CAS is the deeper fix, tracked alongside the job-reaper residual.)
const RECONCILABLE_RECORDING_STATUSES = new Set<RecordingSummary["status"]>([
  "cached",
  "partial",
  "uploaded",
]);

async function reconcilableRecording(recording: RecordingSummary, recordingStore: RecordingStore) {
  const current = await recordingStore.find(recording.id);

  return current && RECONCILABLE_RECORDING_STATUSES.has(current.status) ? current : undefined;
}

// Chunked reconciliation: settle each chunk independently (each is its own object
// across destinations), running per-chunk cache deletion, then promote the
// recording to uploaded/partial once every expected chunk has settled.
async function reconcileChunkedRecordingUpload(
  recording: RecordingSummary,
  chunkItems: UploadQueueItem[],
  recordingStore: RecordingStore,
  auditStore: AuditStore,
): Promise<void> {
  const chunks = await listRecordingChunksForRecording(recording.id);

  if (chunks.length === 0) {
    return;
  }

  // Re-read up front: if the recording moved on (a retry reset it to `recording`,
  // or a terminal decision landed) skip the whole pass — including the per-chunk
  // cache deletion below — so a stale reconcile cannot delete a freshly
  // re-captured chunk's controller cache.
  if (!(await reconcilableRecording(recording, recordingStore))) {
    return;
  }

  const itemsByChunk = new Map<string, UploadQueueItem[]>();

  for (const item of chunkItems) {
    if (!item.chunkId) {
      continue;
    }

    const list = itemsByChunk.get(item.chunkId) ?? [];

    list.push(item);
    itemsByChunk.set(item.chunkId, list);
  }

  for (const chunk of chunks) {
    const items = itemsByChunk.get(chunk.id) ?? [];

    if (items.length === 0) {
      continue;
    }

    const settled = items.every((item) => item.status === "succeeded" || item.status === "failed");
    const succeeded = items.filter((item) => item.status === "succeeded");
    const failed = items.filter((item) => item.status === "failed");
    const nextStatus = chunkUploadStatus(settled, succeeded.length, failed.length);

    // Only release a chunk's cached object once EVERY destination for that chunk
    // is confirmed. A partial chunk still has retryable failed destinations whose
    // only source is this cached object, so deleting it now would strand them
    // permanently — mirrors the whole-recording gate above.
    if (settled && failed.length === 0 && succeeded.length > 0) {
      await deleteChunkCacheIfPolicyAllows(succeeded, chunk);
    }

    if (nextStatus !== chunk.status) {
      chunk.status = nextStatus;
      await upsertRecordingChunk(chunk);
    }
  }

  // Capture is definitively done once the owning job is terminal — no more
  // chunks are coming, so a missing index is a dropped chunk (a render failure
  // orphans one, leaving an index gap the final chunk's chunkTotal overcounts),
  // not one still in flight. Without this signal the recording would hang in
  // `cached` forever when `chunks.length < total`.
  const owningJob = chunks[0]?.jobId ? await recordingJob(chunks[0].jobId) : undefined;
  const captureDone =
    owningJob?.status === "completed" ||
    owningJob?.status === "failed" ||
    owningJob?.status === "cancelled";
  const total = chunks.find((chunk) => chunk.total !== undefined)?.total;
  const finalization = chunkedRecordingFinalization({
    captureDone,
    chunkStatuses: chunks.map((chunk) => chunk.status),
    presentCount: chunks.length,
    total,
  });

  if (!finalization) {
    return;
  }

  // Re-read before promoting so a concurrent retry/terminal decision on the
  // recording isn't overwritten by this (possibly stale) finalization.
  const current = await reconcilableRecording(recording, recordingStore);

  if (!current) {
    return;
  }

  const uploaded = chunks.filter((chunk) => chunk.status === "uploaded").length;
  const degraded = chunks.filter(
    (chunk) => chunk.status === "partial" || chunk.status === "failed",
  ).length;
  const status = finalization.status;

  await recordingStore.save({ ...current, status });
  await appendReconcileAudit(auditStore, current, status, uploaded, degraded, {
    skipped: "chunked_per_chunk_retention",
  });
}

// Decide whether a chunked recording can finalize, and to what status. Kept pure
// so the rules are unit-tested without the store/queue machinery: finalize when
// all present chunks are settled AND either every expected chunk is present or
// capture is done (owning job terminal); a gap (present < total, e.g. a dropped
// chunk) or any degraded chunk means `partial`, not `uploaded`.
export function chunkedRecordingFinalization(input: {
  captureDone: boolean;
  chunkStatuses: RecordingChunkStatus[];
  presentCount: number;
  total: number | undefined;
}): { status: RecordingSummary["status"] } | undefined {
  const settledStatuses: RecordingChunkStatus[] = ["uploaded", "partial", "failed"];
  const allSettled = input.chunkStatuses.every((status) => settledStatuses.includes(status));
  const allPresent = input.total !== undefined && input.presentCount >= input.total;

  if (!allSettled || !(allPresent || input.captureDone)) {
    return undefined;
  }

  const uploaded = input.chunkStatuses.filter((status) => status === "uploaded").length;

  // Every chunk failed: leave the recording cached; failures are retryable.
  if (uploaded === 0) {
    return undefined;
  }

  const degraded = input.chunkStatuses.filter(
    (status) => status === "partial" || status === "failed",
  ).length;
  const hasGap = input.total !== undefined && input.presentCount < input.total;

  return { status: degraded > 0 || hasGap ? "partial" : "uploaded" };
}

function chunkUploadStatus(
  settled: boolean,
  succeeded: number,
  failed: number,
): RecordingChunkStatus {
  if (!settled) {
    return "uploading";
  }

  if (failed === 0) {
    return "uploaded";
  }

  return succeeded > 0 ? "partial" : "failed";
}

// Per-chunk cache-deletion gate: delete a chunk's cached object only when a
// succeeded destination's policy requests it, mirroring the whole-recording gate.
async function deleteChunkCacheIfPolicyAllows(
  succeededItems: UploadQueueItem[],
  chunk: RecordingChunk,
): Promise<void> {
  for (const item of succeededItems) {
    const policy = await uploadPolicyForQueue(item.uploadPolicyId);

    if (policy.deleteCacheAfterUpload) {
      try {
        await deleteRecordingChunkCacheFile(chunk);
      } catch (error) {
        console.warn("chunk cache retention failed", error);
      }

      return;
    }
  }
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
