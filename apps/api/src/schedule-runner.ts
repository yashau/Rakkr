import { randomUUID } from "node:crypto";
import { reportRunnerTickError } from "./runner-tick.js";
import type { AuditEvent, ScheduleSummary } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import type { NodeStore } from "./node-store.js";
import type { RecordingStore } from "./recording-store.js";
import {
  advanceScheduleAfterRun,
  recordingMetadataSnapshot,
  retryScheduleAfterFailure,
  scheduleExecutionSnapshot,
  scheduleIsDue,
  scheduleOccurrenceIsSkipped,
  skipNextScheduleOccurrence,
} from "./schedule-engine.js";
import {
  queueScheduledRecordings,
  scheduledRecordingSegmentSnapshot,
} from "./scheduled-recordings.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";

interface ScheduleRunnerDependencies {
  auditStore: AuditStore;
  healthEventStore?: HealthEventStore;
  nodeStore: NodeStore;
  recordingStore: RecordingStore;
  scheduleStore: ScheduleStore;
  settingsStore: SettingsStore;
}

export interface DueScheduleRun {
  busyChannels?: number[];
  jobId?: string;
  jobIds?: string[];
  outcome: "deferred" | "failed" | "skipped" | "succeeded";
  recordingId?: string;
  recordingIds?: string[];
  reason?: string;
  scheduleId: string;
  segmentCount?: number;
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
        void tick().catch(reportRunnerTickError("schedule runner"));
      }, intervalMs);
      void tick().catch(reportRunnerTickError("schedule runner"));
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
  {
    auditStore,
    healthEventStore,
    nodeStore,
    recordingStore,
    scheduleStore,
    settingsStore,
  }: ScheduleRunnerDependencies,
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
      const result = await queueScheduledRecordings({
        node,
        now,
        recordingStore,
        schedule,
        settingsStore,
      });

      if (result.status === "deferred") {
        // A channel conflict is transient, so retry the deferred occurrence soon
        // instead of advancing the schedule as if it had run — advancing a
        // one-time (or always_on) schedule here silently drops its only
        // occurrence forever. Mirrors the node-not-found retry above.
        const updates = { nextRunAt: retryScheduleAfterFailure(now) };
        const updated = await scheduleStore.update(schedule.id, updates);

        if (healthEventStore) {
          await healthEventStore.create({
            details: {
              busyChannels: result.conflict.busyChannels,
              captureInterfaceId: result.conflict.captureInterfaceId,
              conflictingJobId: result.conflict.conflictingJobId,
              conflictingRecordingId: result.conflict.conflictingRecordingId,
              nodeId: node.id,
              scheduleName: schedule.name,
            },
            nodeId: node.id,
            openedAt: now,
            scheduleId: schedule.id,
            severity: "warning",
            type: "schedule.capture_channels_busy",
          });
        }

        await appendScheduleAudit(auditStore, {
          action: "schedules.due_run.deferred",
          after: {
            conflict: result.conflict,
            nextSchedule: updated ? scheduleExecutionSnapshot(updated) : updates,
          },
          before,
          correlationIds: {
            conflictingRecordingId: result.conflict.conflictingRecordingId,
            scheduleId: schedule.id,
          },
          details: {
            busyChannels: result.conflict.busyChannels,
            captureInterfaceId: result.conflict.captureInterfaceId,
            nodeId: node.id,
          },
          outcome: "partial",
          reason: "capture_channels_busy",
          schedule,
        });
        results.push({
          busyChannels: result.conflict.busyChannels,
          outcome: "deferred",
          reason: "capture_channels_busy",
          scheduleId: schedule.id,
        });
        continue;
      }

      const queued = result.queued;
      const first = queued[0];
      const updates = advanceScheduleAfterRun(schedule, now);
      const updated = await scheduleStore.update(schedule.id, updates);

      if (!first) {
        throw new Error("schedule_due_run_created_no_recordings");
      }

      await appendScheduleAudit(auditStore, {
        action: "schedules.due_run.succeeded",
        after: {
          jobId: first.job.id,
          jobIds: queued.map((segment) => segment.job.id),
          nextSchedule: updated ? scheduleExecutionSnapshot(updated) : updates,
          recordingId: first.recording.id,
          recordingIds: queued.map((segment) => segment.recording.id),
          recordingMetadata: recordingMetadataSnapshot(first.recording),
          segments: queued.map(scheduledRecordingSegmentSnapshot),
        },
        before,
        correlationIds: {
          jobId: first.job.id,
          recordingId: first.recording.id,
          scheduleId: schedule.id,
        },
        details: {
          nodeId: node.id,
          recurrence: schedule.recurrence,
          segmentCount: queued.length,
        },
        outcome: "succeeded",
        schedule,
      });
      results.push({
        jobId: first.job.id,
        jobIds: queued.map((segment) => segment.job.id),
        outcome: "succeeded",
        recordingId: first.recording.id,
        recordingIds: queued.map((segment) => segment.recording.id),
        scheduleId: schedule.id,
        segmentCount: queued.length,
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
