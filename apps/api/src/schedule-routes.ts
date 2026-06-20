import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  scheduleInputSchema,
  scheduleUpdateSchema,
  type RecorderNode,
  type ScheduleRecurrence,
  type ScheduleInput,
  type ScheduleSummary,
  type ScheduleUpdate,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import type { RecordingStore } from "./recording-store.js";
import {
  nextRunAtForRecurrence,
  previewScheduleOccurrences,
  recordingMetadataSnapshot,
  scheduleExecutionSnapshot,
  skipNextScheduleOccurrence,
  uniqueTags,
} from "./schedule-engine.js";
import {
  queueScheduledRecordings,
  scheduledRecordingSegmentSnapshot,
} from "./scheduled-recordings.js";
import { ScheduleStoreError, type ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";

interface ScheduleRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scheduleStore: ScheduleStore;
  scopedSchedules: (user: NonNullable<AuthResult["user"]>) => Promise<ScheduleSummary[]>;
  settingsStore: SettingsStore;
}

export function registerScheduleRoutes({
  app,
  currentAuth,
  currentUser,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scheduleStore,
  scopedSchedules,
  settingsStore,
}: ScheduleRouteDependencies) {
  app.get("/api/v1/schedules", requirePermission("schedule:read", "schedules.read"), async (c) =>
    c.json({ data: await scopedSchedules(currentUser(c)) }),
  );

  app.get(
    "/api/v1/schedules/:scheduleId/occurrences",
    requirePermission("schedule:read", "schedules.occurrences.read", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const schedule = await scheduleStore.find(c.req.param("scheduleId"));

      if (!schedule) {
        return c.json({ error: "Schedule not found" }, 404);
      }

      return c.json({
        data: previewScheduleOccurrences(schedule, occurrenceLimit(c.req.query("limit"))),
      });
    },
  );

  app.post(
    "/api/v1/schedules",
    requirePermission("schedule:manage", "schedules.create", () => ({ type: "schedule" })),
    async (c) => {
      const body = scheduleInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordScheduleWriteFailure(c, "schedules.create.failed", "invalid_request");
        return c.json({ error: "Invalid schedule", issues: body.error.issues }, 400);
      }

      if (!isValidScheduleTiming(body.data)) {
        await recordScheduleWriteFailure(c, "schedules.create.failed", "invalid_next_run_at");
        return c.json({ error: "Invalid next run date" }, 400);
      }

      const node = await nodeStore.find(body.data.nodeId);

      if (!node) {
        await recordScheduleWriteFailure(c, "schedules.create.failed", "schedule_node_not_found");
        return c.json({ error: "Schedule node not found" }, 409);
      }

      if (!scheduleInterfaceIsValid(node, body.data.captureInterfaceId)) {
        await recordScheduleWriteFailure(
          c,
          "schedules.create.failed",
          "schedule_interface_not_found",
        );
        return c.json({ error: "Schedule interface not found" }, 409);
      }

      const schedule = buildSchedule(body.data);

      try {
        const created = await scheduleStore.create(schedule);

        await recordAuditEvent(c, {
          action: "schedules.create.succeeded",
          after: scheduleExecutionSnapshot(created),
          auth: currentAuth(c),
          outcome: "succeeded",
          permission: "schedule:manage",
          target: {
            id: created.id,
            name: created.name,
            type: "schedule",
          },
        });

        return c.json({ data: created }, 201);
      } catch (error) {
        const reason = error instanceof ScheduleStoreError ? error.code : "schedule_create_failed";

        await recordScheduleWriteFailure(c, "schedules.create.failed", reason, schedule);
        return c.json(
          { error: "Schedule could not be created" },
          reason === "schedule_exists" ? 409 : 503,
        );
      }
    },
  );

  app.patch(
    "/api/v1/schedules/:scheduleId",
    requirePermission("schedule:manage", "schedules.update", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const before = await scheduleStore.find(scheduleId);

      if (!before) {
        await recordScheduleWriteFailure(c, "schedules.update.failed", "schedule_not_found", {
          id: scheduleId,
        });
        return c.json({ error: "Schedule not found" }, 404);
      }

      const body = scheduleUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordScheduleWriteFailure(c, "schedules.update.failed", "invalid_request", before);
        return c.json({ error: "Invalid schedule update", issues: body.error.issues }, 400);
      }

      if (!isValidScheduleTiming(body.data)) {
        await recordScheduleWriteFailure(
          c,
          "schedules.update.failed",
          "invalid_next_run_at",
          before,
        );
        return c.json({ error: "Invalid next run date" }, 400);
      }

      const targetNodeId = body.data.nodeId ?? before.nodeId;
      const targetNode = await nodeStore.find(targetNodeId);

      if (!targetNode) {
        await recordScheduleWriteFailure(
          c,
          "schedules.update.failed",
          "schedule_node_not_found",
          before,
        );
        return c.json({ error: "Schedule node not found" }, 409);
      }

      const targetInterfaceId =
        "captureInterfaceId" in body.data
          ? body.data.captureInterfaceId
          : before.captureInterfaceId;

      if (!scheduleInterfaceIsValid(targetNode, targetInterfaceId)) {
        await recordScheduleWriteFailure(
          c,
          "schedules.update.failed",
          "schedule_interface_not_found",
          before,
        );
        return c.json({ error: "Schedule interface not found" }, 409);
      }

      const updated = await scheduleStore.update(
        scheduleId,
        sanitizeScheduleUpdate(body.data, before),
      );

      if (!updated) {
        await recordScheduleWriteFailure(
          c,
          "schedules.update.failed",
          "schedule_not_found",
          before,
        );
        return c.json({ error: "Schedule not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "schedules.update.succeeded",
        after: scheduleExecutionSnapshot(updated),
        auth: currentAuth(c),
        before: scheduleExecutionSnapshot(before),
        outcome: "succeeded",
        permission: "schedule:manage",
        target: {
          id: updated.id,
          name: updated.name,
          type: "schedule",
        },
      });

      return c.json({ data: updated });
    },
  );

  app.post(
    "/api/v1/schedules/:scheduleId/run-now",
    requirePermission("schedule:manage", "schedules.run_now", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const schedule = await scheduleStore.find(scheduleId);

      if (!schedule) {
        await recordScheduleRunFailure(c, scheduleId, "schedule_not_found");
        return c.json({ error: "Schedule not found" }, 404);
      }

      const node = await nodeStore.find(schedule.nodeId);

      if (!node) {
        await recordScheduleRunFailure(c, scheduleId, "schedule_node_not_found", schedule.name);
        return c.json({ error: "Schedule node not found" }, 409);
      }

      const queued = await queueScheduledRecordings({
        node,
        recordingStore,
        schedule,
        settingsStore,
      });
      const first = queued[0];
      const before = scheduleExecutionSnapshot(schedule);

      if (!first) {
        await recordScheduleRunFailure(c, scheduleId, "schedule_run_created_no_recordings");
        return c.json({ error: "Schedule could not create recordings" }, 503);
      }

      await recordAuditEvent(c, {
        action: "schedules.run_now.succeeded",
        after: {
          jobId: first.job.id,
          jobIds: queued.map((segment) => segment.job.id),
          recordingId: first.recording.id,
          recordingIds: queued.map((segment) => segment.recording.id),
          recordingMetadata: recordingMetadataSnapshot(first.recording),
          segments: queued.map(scheduledRecordingSegmentSnapshot),
        },
        auth: currentAuth(c),
        before,
        correlationIds: {
          jobId: first.job.id,
          recordingId: first.recording.id,
          scheduleId: schedule.id,
        },
        details: {
          captureBackend: schedule.captureBackend,
          captureInterfaceId: schedule.captureInterfaceId,
          folderTemplate: schedule.folderTemplate,
          recordingProfileId: schedule.recordingProfileId,
          segmentCount: queued.length,
          titleTemplate: schedule.titleTemplate,
          watchdogPolicyId: schedule.watchdogPolicyId,
        },
        outcome: "succeeded",
        permission: "schedule:manage",
        target: {
          id: schedule.id,
          name: schedule.name,
          type: "schedule",
        },
      });

      return c.json(
        {
          data: first.recording,
          job: first.job,
          segments: queued.map(scheduledRecordingSegmentSnapshot),
        },
        202,
      );
    },
  );

  app.post(
    "/api/v1/schedules/:scheduleId/skip-next",
    requirePermission("schedule:manage", "schedules.skip_next", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const before = await scheduleStore.find(scheduleId);

      if (!before) {
        await recordScheduleWriteFailure(c, "schedules.skip_next.failed", "schedule_not_found", {
          id: scheduleId,
        });
        return c.json({ error: "Schedule not found" }, 404);
      }

      const skipped = skipNextScheduleOccurrence(before);

      if (!skipped) {
        await recordScheduleWriteFailure(
          c,
          "schedules.skip_next.failed",
          "no_next_occurrence",
          before,
        );
        return c.json({ error: "Schedule has no next occurrence to skip" }, 409);
      }

      const updated = await scheduleStore.update(scheduleId, skipped.updates);

      if (!updated) {
        await recordScheduleWriteFailure(
          c,
          "schedules.skip_next.failed",
          "schedule_not_found",
          before,
        );
        return c.json({ error: "Schedule not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "schedules.skip_next.succeeded",
        after: scheduleExecutionSnapshot(updated),
        auth: currentAuth(c),
        before: scheduleExecutionSnapshot(before),
        details: {
          skippedDate: skipped.occurrenceDate,
        },
        outcome: "succeeded",
        permission: "schedule:manage",
        target: {
          id: updated.id,
          name: updated.name,
          type: "schedule",
        },
      });

      return c.json({ data: updated });
    },
  );

  app.delete(
    "/api/v1/schedules/:scheduleId",
    requirePermission("schedule:manage", "schedules.delete", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const deleted = await scheduleStore.delete(scheduleId);

      if (!deleted) {
        await recordScheduleWriteFailure(c, "schedules.delete.failed", "schedule_not_found", {
          id: scheduleId,
        });
        return c.json({ error: "Schedule not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "schedules.delete.succeeded",
        auth: currentAuth(c),
        before: scheduleExecutionSnapshot(deleted),
        outcome: "succeeded",
        permission: "schedule:manage",
        target: {
          id: deleted.id,
          name: deleted.name,
          type: "schedule",
        },
      });

      return c.body(null, 204);
    },
  );

  async function recordScheduleRunFailure(
    c: Context<AppBindings>,
    scheduleId: string,
    reason: string,
    name?: string,
  ) {
    await recordAuditEvent(c, {
      action: "schedules.run_now.failed",
      auth: currentAuth(c),
      outcome: "failed",
      permission: "schedule:manage",
      reason,
      target: {
        id: scheduleId,
        name,
        type: "schedule",
      },
    });
  }

  async function recordScheduleWriteFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    schedule?: Partial<ScheduleSummary>,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: "schedule:manage",
      reason,
      target: {
        id: schedule?.id,
        name: schedule?.name,
        type: "schedule",
      },
    });
  }
}

function buildSchedule(input: ScheduleInput): ScheduleSummary {
  const recurrence = input.recurrence ?? recurrenceFromNextRun(input.nextRunAt);

  return {
    captureBackend: input.captureBackend ?? undefined,
    captureInterfaceId: input.captureInterfaceId ?? undefined,
    enabled: input.enabled,
    folderTemplate: input.folderTemplate,
    id: input.id ?? `sched_${randomUUID()}`,
    name: input.name,
    nextRunAt: nextRunAtForRecurrence(recurrence, input.timezone, input.nextRunAt),
    nodeId: input.nodeId,
    recurrence,
    recordingProfileId: input.recordingProfileId,
    retentionPolicyId: input.retentionPolicyId,
    room: input.room,
    tags: uniqueTags(input.tags),
    timezone: input.timezone,
    titleTemplate: input.titleTemplate,
    uploadPolicyId: input.uploadPolicyId,
    watchdogPolicyId: input.watchdogPolicyId,
  };
}

function sanitizeScheduleUpdate(
  input: ScheduleUpdate,
  before: ScheduleSummary,
): Partial<Omit<ScheduleSummary, "id">> {
  const { captureBackend, captureInterfaceId, ...rest } = input;
  const updates: Partial<Omit<ScheduleSummary, "id">> = { ...rest };

  if ("captureBackend" in input) {
    updates.captureBackend = captureBackend ?? undefined;
  }

  if ("captureInterfaceId" in input) {
    updates.captureInterfaceId = captureInterfaceId ?? undefined;
  }

  if (input.recurrence || input.timezone) {
    updates.nextRunAt = nextRunAtForRecurrence(
      input.recurrence ?? before.recurrence,
      input.timezone ?? before.timezone,
      input.nextRunAt,
    );
  } else if (input.nextRunAt) {
    updates.nextRunAt = validIsoOrUndefined(input.nextRunAt);
  }

  if (input.tags) {
    updates.tags = uniqueTags(input.tags);
  }

  return updates;
}

function isValidScheduleTiming(input: { nextRunAt?: string; recurrence?: ScheduleRecurrence }) {
  const nextRunAt = input.recurrence?.mode === "once" ? input.recurrence.startsAt : input.nextRunAt;

  return isValidOptionalDate(nextRunAt);
}

function isValidOptionalDate(value: string | undefined) {
  return !value || !Number.isNaN(Date.parse(value));
}

function validIsoOrUndefined(value: string | undefined) {
  return value ? new Date(value).toISOString() : undefined;
}

function scheduleInterfaceIsValid(
  node: RecorderNode,
  captureInterfaceId: string | null | undefined,
) {
  return (
    !captureInterfaceId || node.interfaces.some((candidate) => candidate.id === captureInterfaceId)
  );
}

function occurrenceLimit(value: string | undefined) {
  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : 5;
}

function recurrenceFromNextRun(nextRunAt: string | undefined): ScheduleRecurrence {
  return nextRunAt
    ? { mode: "once", startsAt: new Date(nextRunAt).toISOString() }
    : { mode: "manual" };
}
