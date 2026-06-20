import { randomUUID } from "node:crypto";
import type { AuditEvent, RecordingSummary, RetentionPolicy } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import {
  deleteRecordingCacheFile,
  recordingCacheFileSize,
  recordingHasCachedFile,
} from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import { listRetentionPolicies } from "./retention-policies.js";

interface RetentionRunnerDependencies {
  auditStore: AuditStore;
  limit?: number;
  recordingStore: RecordingStore;
}

interface RetentionCandidate {
  recording: RecordingSummary;
  size: number;
}

export interface RetentionRunItem {
  policyId: string;
  recordingId: string;
  reason: "max_age" | "max_bytes";
  status: "deleted" | "failed";
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

export type RetentionRunner = ReturnType<typeof createRetentionRunner>;

export async function runRetentionPass(
  { auditStore, limit = retentionRunnerBatchSize(), recordingStore }: RetentionRunnerDependencies,
  now = new Date(),
) {
  const policies = (await listRetentionPolicies()).filter(executableControllerCachePolicy);
  const recordings = await recordingStore.list();
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

    const candidates = await retentionCandidates(recordings, policy, deletedRecordingIds);
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
      } else {
        summary.errors += 1;
      }
    }
  }

  await appendRunAudit(auditStore, summary, limit);

  return summary;
}

async function retentionCandidates(
  recordings: RecordingSummary[],
  policy: RetentionPolicy,
  deletedRecordingIds: Set<string>,
) {
  const candidates: RetentionCandidate[] = [];

  for (const recording of recordings) {
    if (!recordingHasCachedFile(recording) || deletedRecordingIds.has(recording.id)) {
      continue;
    }

    if (policy.deleteOnlyAfterUploaded && recording.status !== "uploaded") {
      continue;
    }

    if (policy.preserveTagged && recording.tags.length > 0) {
      continue;
    }

    const size = await recordingCacheFileSize(recording);

    if (size === undefined) {
      continue;
    }

    candidates.push({ recording, size });
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
  policy,
  reason,
  recording,
  recordingStore,
}: {
  auditStore: AuditStore;
  policy: RetentionPolicy;
  reason: RetentionRunItem["reason"];
  recording: RecordingSummary;
  recordingStore: RecordingStore;
}): Promise<RetentionRunItem["status"]> {
  try {
    const cacheDeleted = await deleteRecordingCacheFile(recording);

    await recordingStore.save({
      ...recording,
      cachePath: undefined,
      cached: false,
      status: recording.status === "cached" ? "completed" : recording.status,
    });
    await appendItemAudit(auditStore, {
      cacheDeleted,
      policy,
      reason,
      recording,
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
