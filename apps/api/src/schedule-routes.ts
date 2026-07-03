import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  scheduleInputSchema,
  scheduleUpdateSchema,
  type Permission,
  type RecorderNode,
  type ScheduleSummary,
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
import { createScheduleRouteAudit } from "./schedule-route-audit.js";
import { filterSchedules, scheduleFilters } from "./schedule-list-filters.js";
import { registerScheduleCalendarRoutes } from "./schedule-occurrence-routes.js";
import {
  previewScheduleOccurrences,
  recordingMetadataSnapshot,
  scheduleExecutionSnapshot,
  skipNextScheduleOccurrence,
} from "./schedule-engine.js";
import {
  buildSchedule,
  isValidScheduleTiming,
  occurrenceLimit,
  resolveScheduleRoom,
  sanitizeScheduleUpdate,
  scheduleChannelSelectionFailure,
  scheduleInterfaceIsValid,
} from "./schedule-route-helpers.js";
import {
  queueScheduledRecordings,
  scheduledRecordingSegmentSnapshot,
} from "./scheduled-recordings.js";
import { scheduleSettingsSelectionFailure } from "./schedule-settings-scope.js";
import { ScheduleStoreError, type ScheduleStore } from "./schedule-store.js";
import { numberFromQuery, PAGE_POLICY, paginate, parsePagination } from "./pagination.js";
import { schedulesCsv, scheduleExportFileName } from "./schedule-export.js";
import type { SettingsStore } from "./settings-store.js";

interface ScheduleRouteDependencies {
  app: Hono<AppBindings>;
  // Resolves which of the given assignee ids do NOT exist, so schedule
  // create/update can reject unknown users/groups. Defaults to "all known".
  assignmentIdReferences?(input: {
    groupIds: string[];
    userIds: string[];
  }): Promise<{ unknownGroupIds: string[]; unknownUserIds: string[] }>;
  // Roster-aware per-room authorization (mirrors the recording-start check). Used
  // to re-authorize an update that repoints a schedule onto another room's
  // channels, so the schedule-target gate (which resolves to the CURRENT room)
  // cannot be used to seize a room the caller has no capability in.
  authorizeTarget?(
    user: NonNullable<AuthResult["user"]>,
    permission: Permission,
    target: AuditTarget,
  ): Promise<boolean>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope?(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  // Materializes a schedule's assignees into its room's calendar-source roster
  // rows (and clears them when a schedule is removed). Default no-ops.
  reconcileScheduleRoster?(schedule: ScheduleSummary): Promise<void>;
  removeScheduleRoster?(scheduleId: string): Promise<void>;
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
  assignmentIdReferences = async () => ({ unknownGroupIds: [], unknownUserIds: [] }),
  authorizeTarget = async () => true,
  currentAuth,
  currentUser,
  hasResourceScope = async () => true,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  reconcileScheduleRoster = async () => {},
  removeScheduleRoster = async () => {},
  requirePermission,
  scheduleStore,
  scopedNodes,
  scopedSchedules,
  settingsStore,
}: ScheduleRouteDependencies) {
  const {
    recordScheduleReadFailure,
    recordScheduleRunFailure,
    recordScheduleWriteFailure,
    recordSelectedScheduleExportFailure,
    rejectCrossRoomSelection,
  } = createScheduleRouteAudit({ currentAuth, recordAuditEvent });

  // Windowed calendar reads and per-occurrence drag-to-reschedule live in their
  // own module; registered first so /schedules/calendar wins over /:scheduleId.
  registerScheduleCalendarRoutes({
    app,
    currentAuth,
    currentUser,
    recordAuditEvent,
    reconcileScheduleRoster,
    requirePermission,
    scheduleStore,
    scopedNodes,
    scopedSchedules,
  });

  app.get("/api/v1/schedules", requirePermission("schedule:read", "schedules.read"), async (c) => {
    const filters = scheduleFilters(c);
    const schedules = filterSchedules(await scopedSchedules(currentUser(c)), filters);
    const { data, meta } = paginate(
      schedules,
      parsePagination(
        {
          limit: numberFromQuery(c.req.query("limit")),
          offset: numberFromQuery(c.req.query("offset")),
        },
        PAGE_POLICY.default,
      ),
    );

    await recordAuditEvent(c, {
      action: "schedules.read.succeeded",
      auth: currentAuth(c),
      details: {
        filters,
        returnedCount: data.length,
        total: meta.total,
      },
      outcome: "succeeded",
      permission: "schedule:read",
      target: {
        id: "schedule_collection",
        type: "schedule_collection",
      },
    });

    return c.json({ data, meta });
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
    requirePermission("schedule:manage", "schedules.create", async (c) => {
      // Gate creation on the target ROOM so a room BOOK grant authorizes it (not
      // just a global schedule:manage role). Falls back to a generic target when
      // the room cannot be resolved (only a role can then authorize).
      const roomId = await resolveCreateRoomId(c);

      return roomId ? { id: roomId, type: "room" } : { type: "schedule" };
    }),
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

      const createChannelFailure = scheduleChannelSelectionFailure(
        node,
        body.data.captureInterfaceId,
        body.data.captureChannelSelection,
        body.data.channelMode,
      );

      if (createChannelFailure) {
        await recordScheduleWriteFailure(c, "schedules.create.failed", createChannelFailure);
        return c.json(
          { error: "Invalid channel selection", reason: createChannelFailure },
          createChannelFailure === "schedule_interface_not_found" ? 409 : 400,
        );
      }

      const settingsFailure = await recordScheduleSettingsFailure(
        c,
        "schedules.create.failed",
        body.data,
      );

      if (settingsFailure) {
        return settingsFailure;
      }

      const assignmentError = await assignmentValidationError(
        c,
        "schedules.create.failed",
        body.data.assignedUserIds,
        body.data.assignedGroupIds,
      );

      if (assignmentError) {
        return assignmentError;
      }

      const createRoom = resolveScheduleRoom(
        node,
        body.data.captureInterfaceId,
        body.data.captureChannelSelection,
      );

      if (!createRoom.ok) {
        return rejectCrossRoomSelection(c, "schedules.create.failed");
      }

      const schedule = { ...buildSchedule(body.data), roomId: createRoom.roomId };

      try {
        const created = await scheduleStore.create(schedule);
        await reconcileScheduleRoster(created);

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

      const targetSelection =
        "captureChannelSelection" in body.data
          ? body.data.captureChannelSelection
          : before.captureChannelSelection;
      const targetChannelMode =
        "channelMode" in body.data ? body.data.channelMode : before.channelMode;
      const updateChannelFailure = scheduleChannelSelectionFailure(
        targetNode,
        targetInterfaceId,
        targetSelection,
        targetChannelMode,
      );

      if (updateChannelFailure) {
        await recordScheduleWriteFailure(
          c,
          "schedules.update.failed",
          updateChannelFailure,
          before,
        );
        return c.json(
          { error: "Invalid channel selection", reason: updateChannelFailure },
          updateChannelFailure === "schedule_interface_not_found" ? 409 : 400,
        );
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

      if (body.data.assignedUserIds || body.data.assignedGroupIds) {
        const assignmentError = await assignmentValidationError(
          c,
          "schedules.update.failed",
          body.data.assignedUserIds ?? [],
          body.data.assignedGroupIds ?? [],
          before,
        );

        if (assignmentError) {
          return assignmentError;
        }
      }

      // The schedule's room follows its selected channels (re-derived on change).
      const updateRoom = resolveScheduleRoom(targetNode, targetInterfaceId, targetSelection);

      if (!updateRoom.ok) {
        return rejectCrossRoomSelection(c, "schedules.update.failed", before);
      }

      // Repointing the schedule onto a DIFFERENT room must re-authorize against that
      // new room. The PATCH gate only proves authority over the schedule's CURRENT
      // room, so without this a room-A booker could move a schedule onto room B's
      // channels on a shared node. When the new selection resolves room-less (no
      // owning room), fall back to role/grant node authority — a roster-only booker
      // must not repoint a schedule onto unowned channels either (mirrors the
      // ad-hoc recording-start room check and the room-less create fallback).
      if (updateRoom.roomId !== before.roomId) {
        const newRoomTarget: AuditTarget = updateRoom.roomId
          ? { id: updateRoom.roomId, type: "room" }
          : { id: targetNode.id, type: "node" };
        const authorized = updateRoom.roomId
          ? await authorizeTarget(currentUser(c), "schedule:manage", newRoomTarget)
          : await hasResourceScope(currentUser(c), newRoomTarget);

        if (!authorized) {
          await recordScheduleWriteFailure(
            c,
            "schedules.update.failed",
            "missing_resource_scope",
            before,
            newRoomTarget,
          );
          return c.json({ error: "Forbidden", permission: "schedule:manage" }, 403);
        }
      }

      const updates = sanitizeScheduleUpdate(body.data, before);
      updates.roomId = updateRoom.roomId;

      const updated = await scheduleStore.update(scheduleId, updates);

      if (!updated) {
        await recordScheduleWriteFailure(
          c,
          "schedules.update.failed",
          "schedule_not_found",
          before,
        );
        return c.json({ error: "Schedule not found" }, 404);
      }

      await reconcileScheduleRoster(updated);

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

      const result = await queueScheduledRecordings({
        node,
        recordingStore,
        schedule,
        settingsStore,
      });
      const before = scheduleExecutionSnapshot(schedule);

      if (result.status === "deferred") {
        if (result.reason === "cross_room") {
          await recordScheduleRunFailure(
            c,
            scheduleId,
            "channel_selection_cross_room",
            schedule.name,
          );
          return c.json(
            {
              error: "Schedule channels span multiple rooms",
              reason: "channel_selection_cross_room",
            },
            409,
          );
        }

        await recordScheduleRunFailure(c, scheduleId, "capture_channels_busy", schedule.name);
        return c.json(
          {
            busyChannels: result.conflict.busyChannels,
            captureInterfaceId: result.conflict.captureInterfaceId,
            conflictingJobId: result.conflict.conflictingJobId,
            conflictingRecordingId: result.conflict.conflictingRecordingId,
            error:
              result.conflict.busyChannels.length > 0
                ? "Requested channels are already in use"
                : "Capture interface is already in use",
            reason: "capture_channels_busy",
          },
          409,
        );
      }

      const queued = result.queued;
      const first = queued[0];

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

      // Clear the schedule's calendar-derived roster grants (room_roster cascades
      // on the FK too, but the JSON fallback store needs the explicit removal).
      await removeScheduleRoster(scheduleId);

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

  // Resolves the create gate's room from the selected channels (room follows the
  // channels, not the node). Returns undefined when it can't resolve to a single
  // room (unknown node or cross-room selection) so only a role can then authorize.
  async function resolveCreateRoomId(c: Context<AppBindings>) {
    const raw = (await c.req.json().catch(() => ({}))) as {
      captureChannelSelection?: unknown;
      captureInterfaceId?: unknown;
      nodeId?: unknown;
    };
    const nodeId = typeof raw.nodeId === "string" ? raw.nodeId.trim() : "";
    const node = nodeId ? await nodeStore.find(nodeId) : undefined;

    if (!node) {
      return undefined;
    }

    const captureInterfaceId =
      typeof raw.captureInterfaceId === "string" && raw.captureInterfaceId.trim()
        ? raw.captureInterfaceId.trim()
        : undefined;
    const selection = Array.isArray(raw.captureChannelSelection)
      ? raw.captureChannelSelection.filter((value): value is number => typeof value === "number")
      : undefined;
    const resolution = resolveScheduleRoom(node, captureInterfaceId, selection);

    return resolution.ok ? resolution.roomId : undefined;
  }

  // Rejects a create/update whose assignee ids do not resolve to real
  // users/groups. Returns a 400 Response on failure, or undefined when valid.
  async function assignmentValidationError(
    c: Context<AppBindings>,
    action: string,
    userIds: string[],
    groupIds: string[],
    schedule?: Partial<ScheduleSummary>,
  ) {
    if (userIds.length === 0 && groupIds.length === 0) {
      return undefined;
    }

    const { unknownGroupIds, unknownUserIds } = await assignmentIdReferences({ groupIds, userIds });

    if (unknownUserIds.length === 0 && unknownGroupIds.length === 0) {
      return undefined;
    }

    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      details: { unknownGroupIds, unknownUserIds },
      outcome: "failed",
      permission: "schedule:manage",
      reason: "unknown_assignee",
      target: {
        id: schedule?.id,
        name: schedule?.name,
        type: "schedule",
      },
    });

    return c.json(
      { error: "Unknown assignee", reason: "unknown_assignee", unknownGroupIds, unknownUserIds },
      400,
    );
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
}

function uniqueScheduleIds(scheduleIds: string[]) {
  return Array.from(new Set(scheduleIds));
}
