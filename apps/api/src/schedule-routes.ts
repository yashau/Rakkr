import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
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
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import type { RecordingStore } from "./recording-store.js";
import { registerScheduleActionRoutes } from "./schedule-action-routes.js";
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
import { scheduleSettingsSelectionFailure } from "./schedule-settings-scope.js";
import { ScheduleStoreError, type ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";

interface ScheduleRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope?(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scheduleStore: ScheduleStore;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  scopedSchedules: (user: NonNullable<AuthResult["user"]>) => Promise<ScheduleSummary[]>;
  settingsStore: SettingsStore;
}

const scheduleSelectedExportSchema = z
  .object({
    scheduleIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();

export function registerScheduleRoutes({
  app,
  currentAuth,
  currentUser,
  hasResourceScope = async () => true,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scheduleStore,
  scopedNodes,
  scopedSchedules,
  settingsStore,
}: ScheduleRouteDependencies) {
  app.get("/api/v1/schedules", requirePermission("schedule:read", "schedules.read"), async (c) => {
    const filters = scheduleFilters(c);
    const schedules = filterSchedules(await scopedSchedules(currentUser(c)), filters);

    await recordAuditEvent(c, {
      action: "schedules.read.succeeded",
      auth: currentAuth(c),
      details: {
        filters,
        returnedCount: schedules.length,
      },
      outcome: "succeeded",
      permission: "schedule:read",
      target: {
        id: "schedule_collection",
        type: "schedule_collection",
      },
    });

    return c.json({ data: schedules });
  });

  app.get(
    "/api/v1/schedules/export",
    requirePermission("schedule:read", "schedules.export", () => ({
      id: "schedule_collection",
      type: "schedule_collection",
    })),
    async (c) => {
      const filters = scheduleFilters(c);
      const schedules = filterSchedules(await scopedSchedules(currentUser(c)), filters);

      await recordAuditEvent(c, {
        action: "schedules.export.succeeded",
        auth: currentAuth(c),
        details: {
          exportedCount: schedules.length,
          filters,
        },
        outcome: "succeeded",
        permission: "schedule:read",
        target: {
          id: "schedule_collection",
          type: "schedule_collection",
        },
      });

      return c.body(schedulesCsv(schedules), 200, {
        "Content-Disposition": `attachment; filename="${scheduleExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.post(
    "/api/v1/schedules/export",
    requirePermission("schedule:read", "schedules.export_selected", () => ({
      id: "schedule_collection",
      type: "schedule_collection",
    })),
    async (c) => {
      const body = scheduleSelectedExportSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSelectedScheduleExportFailure(c, "invalid_request");
        return c.json({ error: "Invalid schedule export request", issues: body.error.issues }, 400);
      }

      const scheduleIds = uniqueScheduleIds(body.data.scheduleIds);
      const visibleScheduleMap = new Map(
        (await scopedSchedules(currentUser(c))).map((schedule) => [schedule.id, schedule]),
      );
      const hiddenIds = scheduleIds.filter((scheduleId) => !visibleScheduleMap.has(scheduleId));

      if (hiddenIds.length > 0) {
        await recordSelectedScheduleExportFailure(c, "schedule_not_visible", {
          hiddenIds,
          scheduleIds,
        });
        return c.json({ error: "One or more schedules are not visible" }, 404);
      }

      const schedules = scheduleIds.map((scheduleId) => visibleScheduleMap.get(scheduleId)!);

      await recordAuditEvent(c, {
        action: "schedules.export_selected.succeeded",
        auth: currentAuth(c),
        correlationIds: Object.fromEntries(
          scheduleIds.map((scheduleId, index) => [`scheduleId${index + 1}`, scheduleId]),
        ),
        details: {
          exportedCount: schedules.length,
          requestedCount: body.data.scheduleIds.length,
        },
        outcome: "succeeded",
        permission: "schedule:read",
        target: {
          id: "schedule_collection",
          type: "schedule_collection",
        },
      });

      return c.body(schedulesCsv(schedules), 200, {
        "Content-Disposition": `attachment; filename="${scheduleExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.get(
    "/api/v1/schedules/:scheduleId",
    requirePermission("schedule:read", "schedules.detail.read", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const schedule = (await scopedSchedules(currentUser(c))).find(
        (candidate) => candidate.id === scheduleId,
      );

      if (!schedule) {
        await recordScheduleReadFailure(c, "schedules.detail.read.failed", "schedule_not_found", {
          id: scheduleId,
        });
        return c.json({ error: "Schedule not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "schedules.detail.read.succeeded",
        auth: currentAuth(c),
        details: {
          enabled: schedule.enabled,
          nodeId: schedule.nodeId,
        },
        outcome: "succeeded",
        permission: "schedule:read",
        target: {
          id: schedule.id,
          name: schedule.name,
          type: "schedule",
        },
      });

      return c.json({ data: schedule });
    },
  );

  registerScheduleActionRoutes({
    app,
    currentUser,
    recordAuditEvent,
    requirePermission,
    scopedNodes,
    scopedSchedules,
  });

  app.get(
    "/api/v1/schedules/:scheduleId/occurrences",
    requirePermission("schedule:read", "schedules.occurrences.read", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const schedule = await findScopedSchedule(c, c.req.param("scheduleId"));

      if (!schedule) {
        await recordScheduleReadFailure(
          c,
          "schedules.occurrences.read.failed",
          "schedule_not_found",
          {
            id: c.req.param("scheduleId"),
          },
        );
        return c.json({ error: "Schedule not found" }, 404);
      }
      const limit = occurrenceLimit(c.req.query("limit"));
      const occurrences = previewScheduleOccurrences(schedule, limit);

      await recordAuditEvent(c, {
        action: "schedules.occurrences.read.succeeded",
        auth: currentAuth(c),
        details: {
          occurrenceCount: occurrences.length,
          requestedLimit: limit,
        },
        outcome: "succeeded",
        permission: "schedule:read",
        target: {
          id: schedule.id,
          name: schedule.name,
          type: "schedule",
        },
      });

      return c.json({
        data: occurrences,
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

      const node = await findScopedNode(c, body.data.nodeId);

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

      const settingsFailure = await recordScheduleSettingsFailure(
        c,
        "schedules.create.failed",
        body.data,
      );

      if (settingsFailure) {
        return settingsFailure;
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
      const before = await findScopedSchedule(c, scheduleId);

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
      const targetNode = await findScopedNode(c, targetNodeId);

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

      const settingsFailure = await recordScheduleSettingsFailure(
        c,
        "schedules.update.failed",
        body.data,
        before,
      );

      if (settingsFailure) {
        return settingsFailure;
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
      const schedule = await findScopedSchedule(c, scheduleId);

      if (!schedule) {
        await recordScheduleRunFailure(c, scheduleId, "schedule_not_found");
        return c.json({ error: "Schedule not found" }, 404);
      }

      if (!schedule.enabled) {
        await recordScheduleRunFailure(c, scheduleId, "schedule_disabled", schedule.name);
        return c.json({ error: "Disabled schedules cannot be run now" }, 409);
      }

      const node = await findScopedNode(c, schedule.nodeId);

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
      const before = await findScopedSchedule(c, scheduleId);

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
      const before = await findScopedSchedule(c, scheduleId);

      if (!before) {
        await recordScheduleWriteFailure(c, "schedules.delete.failed", "schedule_not_found", {
          id: scheduleId,
        });
        return c.json({ error: "Schedule not found" }, 404);
      }

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

  async function findScopedSchedule(c: Context<AppBindings>, scheduleId: string) {
    return (await scopedSchedules(currentUser(c))).find((schedule) => schedule.id === scheduleId);
  }

  async function findScopedNode(c: Context<AppBindings>, nodeId: string) {
    return (await scopedNodes(currentUser(c))).find((node) => node.id === nodeId);
  }

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
    target?: AuditTarget,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission: "schedule:manage",
      reason,
      target: target ?? {
        id: schedule?.id,
        name: schedule?.name,
        type: "schedule",
      },
    });
  }

  async function recordScheduleReadFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    schedule?: Partial<ScheduleSummary>,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: "schedule:read",
      reason,
      target: {
        id: schedule?.id,
        name: schedule?.name,
        type: "schedule",
      },
    });
  }

  async function recordScheduleSettingsFailure(
    c: Context<AppBindings>,
    action: string,
    selection: Parameters<typeof scheduleSettingsSelectionFailure>[1],
    schedule?: Partial<ScheduleSummary>,
  ) {
    const failure = await scheduleSettingsSelectionFailure(currentUser(c), selection, {
      hasResourceScope,
      settingsStore,
    });

    if (!failure) {
      return undefined;
    }

    await recordScheduleWriteFailure(c, action, failure.reason, schedule, failure.target);
    return c.json({ error: failure.error, permission: "schedule:manage" }, failure.status);
  }

  async function recordSelectedScheduleExportFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "schedules.export_selected.failed",
      auth: currentAuth(c),
      details,
      outcome: reason === "schedule_not_visible" ? "denied" : "failed",
      permission: "schedule:read",
      reason,
      target: {
        id: "schedule_collection",
        type: "schedule_collection",
      },
    });
  }
}

interface ScheduleFilters {
  captureBackend?: NonNullable<ScheduleSummary["captureBackend"]>;
  captureInterfaceId?: string;
  enabled?: boolean;
  nodeId?: string;
  search?: string;
}

function scheduleFilters(c: Context<AppBindings>): ScheduleFilters {
  const captureBackend = captureBackendFromQuery(c.req.query("captureBackend"));
  const captureInterfaceId = trimmed(c.req.query("captureInterfaceId"));
  const enabled = enabledFromQuery(c.req.query("enabled"));
  const nodeId = trimmed(c.req.query("nodeId"));
  const search = trimmed(c.req.query("search"));

  return {
    captureBackend,
    captureInterfaceId,
    enabled,
    nodeId,
    search,
  };
}

function filterSchedules(schedules: ScheduleSummary[], filters: ScheduleFilters) {
  const search = filters.search?.toLowerCase();

  return schedules.filter((schedule) => {
    if (filters.enabled !== undefined && schedule.enabled !== filters.enabled) {
      return false;
    }

    if (filters.nodeId && schedule.nodeId !== filters.nodeId) {
      return false;
    }

    if (filters.captureBackend && schedule.captureBackend !== filters.captureBackend) {
      return false;
    }

    if (filters.captureInterfaceId && schedule.captureInterfaceId !== filters.captureInterfaceId) {
      return false;
    }

    return search ? scheduleSearchText(schedule).includes(search) : true;
  });
}

function scheduleSearchText(schedule: ScheduleSummary) {
  return [
    schedule.captureBackend,
    schedule.captureInterfaceId,
    schedule.folderTemplate,
    schedule.id,
    schedule.name,
    schedule.nodeId,
    schedule.recordingProfileId,
    schedule.retentionPolicyId,
    schedule.room,
    schedule.tags.join(" "),
    schedule.timezone,
    schedule.titleTemplate,
    schedule.uploadPolicyId,
    schedule.watchdogPolicyId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function captureBackendFromQuery(value: string | undefined) {
  return value === "alsa" || value === "jack" || value === "pipewire" ? value : undefined;
}

function enabledFromQuery(value: string | undefined) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function trimmed(value: string | undefined) {
  const next = value?.trim();

  return next || undefined;
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

function schedulesCsv(schedules: ScheduleSummary[]) {
  return [
    csvRow([
      "id",
      "name",
      "enabled",
      "nodeId",
      "room",
      "timezone",
      "nextRunAt",
      "captureBackend",
      "captureInterfaceId",
      "recordingProfileId",
      "watchdogPolicyId",
      "retentionPolicyId",
      "uploadPolicyId",
      "tags",
    ]),
    ...schedules.map((schedule) =>
      csvRow([
        schedule.id,
        schedule.name,
        String(schedule.enabled),
        schedule.nodeId,
        schedule.room,
        schedule.timezone,
        schedule.nextRunAt ?? "",
        schedule.captureBackend ?? "",
        schedule.captureInterfaceId ?? "",
        schedule.recordingProfileId ?? "",
        schedule.watchdogPolicyId ?? "",
        schedule.retentionPolicyId ?? "",
        schedule.uploadPolicyId ?? "",
        schedule.tags.join(";"),
      ]),
    ),
  ].join("\n");
}

function scheduleExportFileName() {
  return `rakkr-schedules-${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}.csv`;
}

function csvRow(values: string[]) {
  return values.map(csvCell).join(",");
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function uniqueScheduleIds(scheduleIds: string[]) {
  return Array.from(new Set(scheduleIds));
}
