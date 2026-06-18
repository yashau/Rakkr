import { randomUUID } from "node:crypto";
import type { AuditEvent, ScheduleSummary } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { NodeStore } from "./node-store.js";
import { createRecordingJob } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import {
  advanceScheduleAfterRun,
  materializeScheduledRecording,
  recordingMetadataSnapshot,
  retryScheduleAfterFailure,
  scheduleExecutionSnapshot,
  scheduleIsDue,
  scheduleOccurrenceIsSkipped,
  scheduleRecordingDurationSeconds,
  skipNextScheduleOccurrence,
} from "./schedule-engine.js";
import type { ScheduleStore } from "./schedule-store.js";

interface ScheduleRunnerDependencies {
  auditStore: AuditStore;
  nodeStore: NodeStore;
  recordingStore: RecordingStore;
  scheduleStore: ScheduleStore;
}

export interface DueScheduleRun {
  jobId?: string;
  outcome: "failed" | "skipped" | "succeeded";
  recordingId?: string;
  reason?: string;
  scheduleId: string;
}

export function createScheduleRunner(dependencies: ScheduleRunnerDependencies) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(now = new Date()) {
    if (running) {
      return [];
    }

    running = true;

    try {
      return await runDueSchedules(dependencies, now);
    } finally {
      running = false;
    }
  }

  return {
    async runOnce(now = new Date()) {
      return tick(now);
    },
    start(intervalMs = scheduleRunnerIntervalMs()) {
      if (timer) {
        return;
      }

      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export async function runDueSchedules(
  { auditStore, nodeStore, recordingStore, scheduleStore }: ScheduleRunnerDependencies,
  now = new Date(),
) {
  const results: DueScheduleRun[] = [];

  for (const schedule of await scheduleStore.list()) {
    if (!scheduleIsDue(schedule, now)) {
      continue;
    }

    const before = scheduleExecutionSnapshot(schedule);

    if (scheduleOccurrenceIsSkipped(schedule)) {
      const skipped = skipNextScheduleOccurrence(schedule);
      const updated = skipped
        ? await scheduleStore.update(schedule.id, skipped.updates)
        : undefined;

      await appendScheduleAudit(auditStore, {
        action: "schedules.due_run.skipped",
        after: updated ? scheduleExecutionSnapshot(updated) : skipped?.updates,
        before,
        details: {
          skippedDate: skipped?.occurrenceDate,
        },
        outcome: "succeeded",
        reason: "schedule_occurrence_skipped",
        schedule,
      });
      results.push({
        outcome: "skipped",
        reason: "schedule_occurrence_skipped",
        scheduleId: schedule.id,
      });
      continue;
    }

    const node = await nodeStore.find(schedule.nodeId);

    if (!node) {
      await scheduleStore.update(schedule.id, { nextRunAt: retryScheduleAfterFailure(now) });
      await appendScheduleAudit(auditStore, {
        action: "schedules.due_run.failed",
        before,
        details: { nodeId: schedule.nodeId },
        outcome: "failed",
        reason: "schedule_node_not_found",
        schedule,
      });
      results.push({
        outcome: "failed",
        reason: "schedule_node_not_found",
        scheduleId: schedule.id,
      });
      continue;
    }

    try {
      const recording = materializeScheduledRecording(schedule, node, now);

      await recordingStore.create(recording);
      const job = await createRecordingJob(recording, {
        durationSeconds: scheduleRecordingDurationSeconds(schedule),
      });
      const updates = advanceScheduleAfterRun(schedule, now);
      const updated = await scheduleStore.update(schedule.id, updates);

      await appendScheduleAudit(auditStore, {
        action: "schedules.due_run.succeeded",
        after: {
          jobId: job.id,
          nextSchedule: updated ? scheduleExecutionSnapshot(updated) : updates,
          recordingId: recording.id,
          recordingMetadata: recordingMetadataSnapshot(recording),
        },
        before,
        correlationIds: {
          jobId: job.id,
          recordingId: recording.id,
          scheduleId: schedule.id,
        },
        details: {
          nodeId: node.id,
          recurrence: schedule.recurrence,
        },
        outcome: "succeeded",
        schedule,
      });
      results.push({
        jobId: job.id,
        outcome: "succeeded",
        recordingId: recording.id,
        scheduleId: schedule.id,
      });
    } catch (error) {
      const retryAt = retryScheduleAfterFailure(now);

      await scheduleStore.update(schedule.id, { nextRunAt: retryAt });
      await appendScheduleAudit(auditStore, {
        action: "schedules.due_run.failed",
        before,
        details: {
          retryAt,
        },
        outcome: "failed",
        reason: error instanceof Error ? error.message : "schedule_due_run_failed",
        schedule,
      });
      results.push({
        outcome: "failed",
        reason: "schedule_due_run_failed",
        scheduleId: schedule.id,
      });
    }
  }

  return results;
}

async function appendScheduleAudit(
  auditStore: AuditStore,
  input: {
    action: string;
    after?: Record<string, unknown>;
    before?: Record<string, unknown>;
    correlationIds?: Record<string, string>;
    details?: Record<string, unknown>;
    outcome: AuditEvent["outcome"];
    reason?: string;
    schedule: ScheduleSummary;
  },
) {
  await auditStore.append({
    action: input.action,
    actor: {
      id: "system:scheduler",
      name: "Rakkr Scheduler",
      roles: [],
      type: "system",
    },
    actorContext: {},
    after: input.after,
    before: input.before,
    correlationIds: input.correlationIds,
    createdAt: new Date().toISOString(),
    details: input.details ?? {},
    id: `audit_${randomUUID()}`,
    outcome: input.outcome,
    permission: "schedule:manage",
    reason: input.reason,
    target: {
      id: input.schedule.id,
      name: input.schedule.name,
      type: "schedule",
    },
  });
}

function scheduleRunnerIntervalMs() {
  return positiveInteger(process.env.RAKKR_SCHEDULE_RUNNER_INTERVAL_SECONDS, 30) * 1_000;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
