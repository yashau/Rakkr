import { randomUUID } from "node:crypto";
import type { AuditEvent, UploadQueueRunItem, UploadQueueRunSummary } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { UploadProviderStore } from "./upload-providers.js";
import { runUploadQueueOnce } from "./upload-executor.js";

interface UploadRunnerDependencies {
  auditStore: AuditStore;
  limit?: number;
  providerStore: UploadProviderStore;
}

export function createUploadRunner(dependencies: UploadRunnerDependencies) {
  const batchSize = dependencies.limit ?? uploadRunnerBatchSize();
  let intervalMs = uploadRunnerIntervalMs();
  let lastRunAt: string | undefined;
  let lastSummary: UploadQueueRunSummary | undefined;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(now = new Date()) {
    if (running) {
      return emptySummary();
    }

    running = true;

    try {
      const summary = await runUploadQueuePass({ ...dependencies, limit: batchSize }, now);

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
  { auditStore, limit = uploadRunnerBatchSize(), providerStore }: UploadRunnerDependencies,
  now = new Date(),
) {
  const summary = await runUploadQueueOnce({ limit, now, providerStore });

  if (summary.attempted === 0) {
    return summary;
  }

  await appendUploadRunAudit(auditStore, summary, limit);

  for (const item of summary.items) {
    await appendUploadItemAudit(auditStore, item);
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

async function appendUploadItemAudit(auditStore: AuditStore, item: UploadQueueRunItem) {
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
