import { randomUUID } from "node:crypto";
import { reportRunnerTickError } from "./runner-tick.js";
import type { AuditEvent, RecordingChunk, RecordingSummary, RetentionPolicy } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import {
  deleteRecordingCacheFile,
  deleteRecordingChunkCacheFile,
  recordingCacheFileSize,
  recordingChunkCacheFileSize,
  recordingHasReclaimableCache,
} from "./recording-cache.js";
import { listRecordingChunksForRecording, upsertRecordingChunk } from "./recording-chunks.js";
import type { RecordingStore } from "./recording-store.js";
import { listRetentionPolicies } from "./retention-policies.js";
import { listUploadQueueItems } from "./upload-queue.js";

// Upload-queue statuses whose only source is still this cache file. `partial`
// recordings are floored by status, but a `cached` recording with unsettled
// uploads would have its cache deleted out from under them. This includes
// `failed`: a failed item is operator-retryable (retry resets it to retrying),
// and when EVERY destination fails the recording stays `cached` (not `partial`),
// so it escapes the status floor. Only `succeeded` (done) and `cancelled`
// (operator gave up — reclaim intended) are settled; everything else keeps the
// cache. Deleting it strands every retry with cache_path_missing = lost audio.
const UNSETTLED_UPLOAD_STATUSES = new Set(["queued", "retrying", "failed"]);

async function recordingIdsWithUnsettledUploads(): Promise<Set<string>> {
  const items = await listUploadQueueItems();

  return new Set(
    items
      .filter((item) => UNSETTLED_UPLOAD_STATUSES.has(item.status))
      .map((item) => item.recordingId),
  );
}

interface RetentionRunnerDependencies {
  auditStore: AuditStore;
  limit?: number;
  recordingStore: RecordingStore;
}

interface RetentionCandidate {
  chunks: RecordingChunk[];
  recording: RecordingSummary;
  size: number;
}

export interface RetentionRunItem {
  policyId: string;
  recordingId: string;
  reason: "max_age" | "max_bytes";
  status: "deleted" | "failed" | "skipped";
}

export interface RetentionRunSummary {
  attemptedPolicies: number;
  deleted: number;
  errors: number;
  items: RetentionRunItem[];
  scannedRecordings: number;
}

export function createRetentionRunner(dependencies: RetentionRunnerDependencies) {
  const batchSize = dependencies.limit ?? retentionRunnerBatchSize();
  let intervalMs = retentionRunnerIntervalMs();
  let lastRunAt: string | undefined;
  let lastSummary: RetentionRunSummary | undefined;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(now = new Date()) {
    if (running) {
      return emptySummary();
    }

    running = true;

    try {
      const summary = await runRetentionPass({ ...dependencies, limit: batchSize }, now);

      lastRunAt = new Date().toISOString();
      lastSummary = summary;

      return summary;
    } finally {
      running = false;
    }
  }

  return {
    async runOnce(now = new Date()) {
      return tick(now);
    },
    start(nextIntervalMs = retentionRunnerIntervalMs()) {
      if (timer) {
        return;
      }

      intervalMs = nextIntervalMs;
      timer = setInterval(() => {
        void tick().catch(reportRunnerTickError("retention runner"));
      }, nextIntervalMs);
      void tick().catch(reportRunnerTickError("retention runner"));
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

export type RetentionRunner = ReturnType<typeof createRetentionRunner>;

export async function runRetentionPass(
  { auditStore, limit = retentionRunnerBatchSize(), recordingStore }: RetentionRunnerDependencies,
  now = new Date(),
) {
  const policies = (await listRetentionPolicies()).filter(executableControllerCachePolicy);
  const recordings = await recordingStore.list();
  const recordingsWithUnsettledUploads = await recordingIdsWithUnsettledUploads();
  const summary: RetentionRunSummary = {
    attemptedPolicies: policies.length,
    deleted: 0,
    errors: 0,
    items: [],
    scannedRecordings: recordings.length,
  };
  const deletedRecordingIds = new Set<string>();

  for (const policy of policies) {
    if (summary.deleted >= limit) {
      break;
    }

    const candidates = await retentionCandidates(
      recordings,
      policy,
      deletedRecordingIds,
      recordingsWithUnsettledUploads,
    );
    const deletionReasons = deletionPlan(candidates, policy, now);

    for (const [recordingId, reason] of deletionReasons) {
      if (summary.deleted >= limit) {
        break;
      }

      const candidate = candidates.find((item) => item.recording.id === recordingId);

      if (!candidate) {
        continue;
      }

      const status = await deleteCandidate({
        auditStore,
        chunks: candidate.chunks,
        policy,
        reason,
        recording: candidate.recording,
        recordingStore,
      });

      summary.items.push({
        policyId: policy.id,
        reason,
        recordingId: candidate.recording.id,
        status,
      });

      if (status === "deleted") {
        summary.deleted += 1;
        deletedRecordingIds.add(candidate.recording.id);
      } else if (status === "failed") {
        summary.errors += 1;
      }
      // `skipped` (the recording moved on between planning and delete) is neither
      // a deletion nor an error — leave both counters untouched.
    }
  }

  await appendRunAudit(auditStore, summary, limit);

  return summary;
}

async function retentionCandidates(
  recordings: RecordingSummary[],
  policy: RetentionPolicy,
  deletedRecordingIds: Set<string>,
  recordingsWithUnsettledUploads: Set<string>,
) {
  const candidates: RetentionCandidate[] = [];

  for (const recording of recordings) {
    if (deletedRecordingIds.has(recording.id)) {
      continue;
    }

    // A partial recording still has failed-but-retryable upload destinations
    // whose only source is this cache file. Never delete it, independent of
    // deleteOnlyAfterUploaded — that flag governs cached-vs-uploaded retention,
    // not the data-loss floor for in-flight uploads.
    if (recording.status === "partial") {
      continue;
    }

    // Same floor for a `cached` recording whose uploads are unsettled
    // (queued/retrying/failed): deleting the cache now strands every pending or
    // operator-retryable upload with cache_path_missing and loses the audio.
    if (recordingsWithUnsettledUploads.has(recording.id)) {
      continue;
    }

    if (policy.deleteOnlyAfterUploaded && recording.status !== "uploaded") {
      continue;
    }

    if (recording.retentionPolicyId !== policy.id) {
      continue;
    }

    if (policy.preserveTagged && recording.tags.length > 0) {
      continue;
    }

    // Cache footprint spans the whole-file rendition (if any) plus every chunk's
    // renditions — chunked recordings carry no recording-level cachePath, so
    // sizing/eligibility must sum the chunk files or they escape retention.
    const chunks = await listRecordingChunksForRecording(recording.id);
    const wholeFileSize = recordingHasReclaimableCache(recording)
      ? await recordingCacheFileSize(recording)
      : undefined;
    let size = wholeFileSize ?? 0;

    for (const chunk of chunks) {
      size += await recordingChunkCacheFileSize(chunk);
    }

    if (size <= 0) {
      continue;
    }

    candidates.push({ chunks, recording, size });
  }

  return candidates;
}

function deletionPlan(
  candidates: RetentionCandidate[],
  policy: RetentionPolicy,
  now: Date,
): Map<string, RetentionRunItem["reason"]> {
  const reasons = new Map<string, RetentionRunItem["reason"]>();

  if (policy.maxAgeDays !== null) {
    const oldestKeptTime = now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1_000;

    for (const candidate of candidates) {
      if (new Date(candidate.recording.recordedAt).getTime() <= oldestKeptTime) {
        reasons.set(candidate.recording.id, "max_age");
      }
    }
  }

  if (policy.maxBytes !== null) {
    let totalBytes = candidates.reduce((total, candidate) => total + candidate.size, 0);
    const oldestFirst = [...candidates].sort(
      (left, right) =>
        new Date(left.recording.recordedAt).getTime() -
        new Date(right.recording.recordedAt).getTime(),
    );

    for (const candidate of oldestFirst) {
      if (totalBytes <= policy.maxBytes) {
        break;
      }

      if (!reasons.has(candidate.recording.id)) {
        reasons.set(candidate.recording.id, "max_bytes");
      }

      totalBytes -= candidate.size;
    }
  }

  return reasons;
}

async function deleteCandidate({
  auditStore,
  chunks,
  policy,
  reason,
  recording,
  recordingStore,
}: {
  auditStore: AuditStore;
  chunks: RecordingChunk[];
  policy: RetentionPolicy;
  reason: RetentionRunItem["reason"];
  recording: RecordingSummary;
  recordingStore: RecordingStore;
}): Promise<RetentionRunItem["status"]> {
  // Re-read immediately before acting: this pass was planned from a list snapshot
  // taken earlier, and a concurrent upload-reconcile (which may have promoted the
  // recording to `uploaded` and released its cache) or a retry (reset to
  // `recording`) must not be overwritten. Only reclaim a still-cached/uploaded
  // recording, and derive the post-delete status from the fresh read — a stale
  // `cached` snapshot must not downgrade a now-`uploaded` recording to `completed`.
  const current = await recordingStore.find(recording.id);

  if (!current || (current.status !== "cached" && current.status !== "uploaded")) {
    return "skipped";
  }

  try {
    let cacheDeleted = recordingHasReclaimableCache(current)
      ? await deleteRecordingCacheFile(current)
      : false;

    for (const chunk of chunks) {
      if (await deleteRecordingChunkCacheFile(chunk)) {
        cacheDeleted = true;
      }

      // Keep the chunk row as metadata but drop its now-deleted cache paths so
      // reads don't dangle — the analog of clearing recording.cachePath.
      if (chunk.cachePath || chunk.rawCachePath || chunk.enhancedCachePath) {
        await upsertRecordingChunk({
          ...chunk,
          cachePath: undefined,
          enhancedCachePath: undefined,
          rawCachePath: undefined,
        });
      }
    }

    await recordingStore.save({
      ...current,
      cachePath: undefined,
      cached: false,
      status: current.status === "cached" ? "completed" : current.status,
    });
    await appendItemAudit(auditStore, {
      cacheDeleted,
      policy,
      reason,
      recording: current,
      status: "deleted",
    });

    return "deleted";
  } catch (error) {
    await appendItemAudit(auditStore, {
      error: error instanceof Error ? error.message : "retention_delete_failed",
      policy,
      reason,
      recording,
      status: "failed",
    });

    return "failed";
  }
}

async function appendItemAudit(
  auditStore: AuditStore,
  {
    cacheDeleted,
    error,
    policy,
    reason,
    recording,
    status,
  }: {
    cacheDeleted?: boolean;
    error?: string;
    policy: RetentionPolicy;
    reason: RetentionRunItem["reason"];
    recording: RecordingSummary;
    status: RetentionRunItem["status"];
  },
) {
  await auditStore.append({
    action:
      status === "deleted"
        ? "recordings.retention.cache_deleted"
        : "recordings.retention.cache_failed",
    actor: retentionRunnerActor(),
    actorContext: {},
    correlationIds: {
      policyId: policy.id,
      recordingId: recording.id,
    },
    createdAt: new Date().toISOString(),
    details: {
      cacheDeleted,
      error,
      policyId: policy.id,
      reason,
    },
    id: `audit_${randomUUID()}`,
    outcome: status === "deleted" ? "succeeded" : "failed",
    permission: "recording:delete",
    reason: status === "failed" ? "retention_delete_failed" : reason,
    target: {
      id: recording.id,
      name: recording.name,
      type: "recording",
    },
  });
}

async function appendRunAudit(auditStore: AuditStore, summary: RetentionRunSummary, limit: number) {
  await auditStore.append({
    action: "recordings.retention.runner.completed",
    actor: retentionRunnerActor(),
    actorContext: {},
    createdAt: new Date().toISOString(),
    details: {
      attemptedPolicies: summary.attemptedPolicies,
      deleted: summary.deleted,
      errors: summary.errors,
      limit,
      scannedRecordings: summary.scannedRecordings,
    },
    id: `audit_${randomUUID()}`,
    outcome: summary.errors > 0 ? "partial" : "succeeded",
    permission: "recording:delete",
    target: {
      type: "recording_collection",
    },
  });
}

function executableControllerCachePolicy(policy: RetentionPolicy) {
  return policy.enabled && policy.scope === "controller_cache" && policy.action === "delete_cache";
}

function retentionRunnerActor(): AuditEvent["actor"] {
  return {
    id: "system:retention-runner",
    name: "Rakkr Retention Runner",
    roles: [],
    type: "system",
  };
}

function emptySummary(): RetentionRunSummary {
  return {
    attemptedPolicies: 0,
    deleted: 0,
    errors: 0,
    items: [],
    scannedRecordings: 0,
  };
}

function retentionRunnerIntervalMs() {
  return positiveInteger(process.env.RAKKR_RETENTION_RUNNER_INTERVAL_SECONDS, 300) * 1_000;
}

function retentionRunnerBatchSize() {
  return positiveInteger(process.env.RAKKR_RETENTION_RUNNER_BATCH_SIZE, 25);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
