import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { RecorderNode, ScheduleCalendarOccurrence, ScheduleSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import { filterSchedules, scheduleFilters } from "./schedule-list-filters.js";
import {
  nextRunAtForRecurrence,
  occurrenceLocalDateIso,
  recurrenceWithSkip,
  scheduleExecutionSnapshot,
  scheduleRecordingDurationSeconds,
  windowScheduleOccurrences,
} from "./schedule-engine.js";
import { ScheduleStoreError, type ScheduleStore } from "./schedule-store.js";

interface ScheduleCalendarRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  // Materializes the moved occurrence clone's assignees into its room's
  // calendar-source roster (a move creates a new one-off schedule, so it must
  // auto-populate the roster like any other schedule create). Default no-op.
  reconcileScheduleRoster?(schedule: ScheduleSummary): Promise<void>;
  requirePermission: RequirePermission;
  scheduleStore: ScheduleStore;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  scopedSchedules: (user: NonNullable<AuthResult["user"]>) => Promise<ScheduleSummary[]>;
}

const isoInstantSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalid_datetime");
const moveOccurrenceSchema = z
  .object({
    // The new recording start for the dragged occurrence.
    newStartAt: isoInstantSchema,
    // The original recording start of the occurrence being moved (used to
    // compute which recurring instance to skip; ignored for one-offs).
    occurrenceStartAt: isoInstantSchema,
  })
  .strict();

const CALENDAR_OCCURRENCE_CAP = 2000;
const CALENDAR_ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_MAX_WINDOW_MS = 92 * CALENDAR_ONE_DAY_MS;

type CalendarWindow = { end: Date; ok: true; start: Date } | { ok: false; reason: string };

function parseCalendarWindow(
  startQuery: string | undefined,
  endQuery: string | undefined,
): CalendarWindow {
  const start = startQuery ? new Date(startQuery) : new Date();

  if (Number.isNaN(start.getTime())) {
    return { ok: false, reason: "invalid_start" };
  }

  const end = endQuery ? new Date(endQuery) : new Date(start.getTime() + 42 * CALENDAR_ONE_DAY_MS);

  if (Number.isNaN(end.getTime())) {
    return { ok: false, reason: "invalid_end" };
  }

  if (end.getTime() < start.getTime()) {
    return { ok: false, reason: "end_before_start" };
  }

  if (end.getTime() - start.getTime() > CALENDAR_MAX_WINDOW_MS) {
    return { ok: false, reason: "window_too_large" };
  }

  return { end, ok: true, start };
}

function movedOccurrenceName(name: string) {
  const suffix = " (moved)";

  if (name.endsWith(suffix)) {
    return name;
  }

  const combined = `${name}${suffix}`;

  return combined.length <= 160 ? combined : combined.slice(0, 160);
}

// Windowed calendar reads plus per-occurrence drag-to-reschedule. Split out of
// schedule-routes.ts to keep each route module within the LOC budget.
export function registerScheduleCalendarRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  reconcileScheduleRoster = async () => {},
  requirePermission,
  scheduleStore,
  scopedNodes,
  scopedSchedules,
}: ScheduleCalendarRouteDependencies) {
  app.get(
    "/api/v1/schedules/calendar",
    requirePermission("schedule:read", "schedules.calendar.read", () => ({
      id: "schedule_collection",
      type: "schedule_collection",
    })),
    async (c) => {
      const window = parseCalendarWindow(c.req.query("start"), c.req.query("end"));

      if (!window.ok) {
        await recordFailure(
          c,
          "schedules.calendar.read.failed",
          window.reason,
          "schedule:read",
          collectionTarget(),
        );
        return c.json({ error: "Invalid calendar window", reason: window.reason }, 400);
      }

      const filters = scheduleFilters(c);
      const schedules = filterSchedules(await scopedSchedules(currentUser(c)), filters);
      const occurrences: ScheduleCalendarOccurrence[] = [];
      let truncated = false;

      for (const schedule of schedules) {
        if (!schedule.enabled) {
          continue;
        }

        const remaining = CALENDAR_OCCURRENCE_CAP - occurrences.length;

        if (remaining <= 0) {
          truncated = true;
          break;
        }

        const windowed = windowScheduleOccurrences(
          schedule,
          window.start,
          window.end,
          remaining + 1,
        );

        for (const occurrence of windowed) {
          if (occurrences.length >= CALENDAR_OCCURRENCE_CAP) {
            truncated = true;
            break;
          }

          occurrences.push({
            ...occurrence,
            enabled: schedule.enabled,
            nodeId: schedule.nodeId,
            recurrenceMode: schedule.recurrence.mode,
            room: schedule.room,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
          });
        }

        if (truncated) {
          break;
        }
      }

      occurrences.sort((left, right) =>
        left.recordingStartAt.localeCompare(right.recordingStartAt),
      );

      const meta = {
        end: window.end.toISOString(),
        occurrenceCount: occurrences.length,
        scheduleCount: schedules.length,
        start: window.start.toISOString(),
        truncated,
      };

      await recordAuditEvent(c, {
        action: "schedules.calendar.read.succeeded",
        auth: currentAuth(c),
        details: { ...meta, filters },
        outcome: "succeeded",
        permission: "schedule:read",
        target: collectionTarget(),
      });

      return c.json({ data: occurrences, meta });
    },
  );

  app.post(
    "/api/v1/schedules/:scheduleId/move-occurrence",
    requirePermission("schedule:manage", "schedules.occurrence.move", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const before = await findScopedSchedule(c, scheduleId);

      if (!before) {
        await recordMoveFailure(c, "schedule_not_found", { id: scheduleId });
        return c.json({ error: "Schedule not found" }, 404);
      }

      const body = moveOccurrenceSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordMoveFailure(c, "invalid_request", before);
        return c.json({ error: "Invalid occurrence move", issues: body.error.issues }, 400);
      }

      const node = await findScopedNode(c, before.nodeId);

      if (!node) {
        await recordMoveFailure(c, "schedule_node_not_found", before);
        return c.json({ error: "Schedule node not found" }, 409);
      }

      const mode = before.recurrence.mode;

      if (mode === "manual" || mode === "always_on") {
        await recordMoveFailure(c, "occurrence_not_movable", before);
        return c.json(
          { error: "This schedule has no movable occurrences", reason: "occurrence_not_movable" },
          409,
        );
      }

      const newStartAt = new Date(body.data.newStartAt).toISOString();

      // One-off: move the single occurrence in place.
      if (mode === "once") {
        const recurrence = { ...before.recurrence, startsAt: newStartAt };
        const updated = await scheduleStore.update(scheduleId, {
          nextRunAt: nextRunAtForRecurrence(recurrence, before.timezone, undefined),
          recurrence,
        });

        if (!updated) {
          await recordMoveFailure(c, "schedule_not_found", before);
          return c.json({ error: "Schedule not found" }, 404);
        }

        await recordAuditEvent(c, {
          action: "schedules.occurrence.move.succeeded",
          after: scheduleExecutionSnapshot(updated),
          auth: currentAuth(c),
          before: scheduleExecutionSnapshot(before),
          details: { mode, newStartAt },
          outcome: "succeeded",
          permission: "schedule:manage",
          target: { id: updated.id, name: updated.name, type: "schedule" },
        });

        return c.json({ data: updated });
      }

      // Recurring: skip the original instance and clone it into a one-off at the
      // new time, preserving the recording duration, assignees, and capture setup.
      const occurrenceDate = occurrenceLocalDateIso(
        before,
        new Date(body.data.occurrenceStartAt).toISOString(),
      );
      const skippedRecurrence = recurrenceWithSkip(before.recurrence, occurrenceDate);
      const durationSeconds = scheduleRecordingDurationSeconds(before);
      const cloneRecurrence = {
        mode: "once" as const,
        startsAt: newStartAt,
        ...(durationSeconds ? { durationSeconds } : {}),
      };
      const clone: ScheduleSummary = {
        ...before,
        assignedGroupIds: [...before.assignedGroupIds],
        assignedUserIds: [...before.assignedUserIds],
        captureChannelSelection: before.captureChannelSelection
          ? [...before.captureChannelSelection]
          : undefined,
        id: `sched_${randomUUID()}`,
        name: movedOccurrenceName(before.name),
        nextRunAt: nextRunAtForRecurrence(cloneRecurrence, before.timezone, undefined),
        recurrence: cloneRecurrence,
        tags: [...before.tags],
        uploadPolicyIds: [...before.uploadPolicyIds],
      };

      const updatedOriginal = await scheduleStore.update(scheduleId, {
        nextRunAt: nextRunAtForRecurrence(skippedRecurrence, before.timezone, undefined),
        recurrence: skippedRecurrence,
      });

      if (!updatedOriginal) {
        await recordMoveFailure(c, "schedule_not_found", before);
        return c.json({ error: "Schedule not found" }, 404);
      }

      let created: ScheduleSummary;

      try {
        created = await scheduleStore.create(clone);
      } catch (error) {
        // Roll the original series back so a failed clone leaves no orphaned skip.
        await scheduleStore.update(scheduleId, {
          nextRunAt: before.nextRunAt,
          recurrence: before.recurrence,
        });
        const reason = error instanceof ScheduleStoreError ? error.code : "occurrence_move_failed";
        await recordMoveFailure(c, reason, before);
        return c.json({ error: "Occurrence could not be moved" }, 503);
      }

      // The clone is a new schedule carrying the occurrence's assignees, so
      // auto-populate its room's calendar roster like any other schedule create —
      // otherwise the moved occurrence's own roster attribution is missing (and the
      // assignees would lose access if the original series is later removed).
      await reconcileScheduleRoster(created);

      await recordAuditEvent(c, {
        action: "schedules.occurrence.move.succeeded",
        after: scheduleExecutionSnapshot(created),
        auth: currentAuth(c),
        before: scheduleExecutionSnapshot(before),
        correlationIds: { movedScheduleId: created.id, scheduleId: before.id },
        details: { durationSeconds, mode, newStartAt, occurrenceDate },
        outcome: "succeeded",
        permission: "schedule:manage",
        target: { id: created.id, name: created.name, type: "schedule" },
      });

      return c.json({ data: created, source: updatedOriginal }, 201);
    },
  );

  async function findScopedSchedule(c: Context<AppBindings>, scheduleId: string) {
    return (await scopedSchedules(currentUser(c))).find((schedule) => schedule.id === scheduleId);
  }

  async function findScopedNode(c: Context<AppBindings>, nodeId: string) {
    return (await scopedNodes(currentUser(c))).find((node) => node.id === nodeId);
  }

  async function recordFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    permission: "schedule:manage" | "schedule:read",
    target: AuditTarget,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission,
      reason,
      target,
    });
  }

  async function recordMoveFailure(
    c: Context<AppBindings>,
    reason: string,
    schedule?: Partial<ScheduleSummary>,
  ) {
    await recordFailure(c, "schedules.occurrence.move.failed", reason, "schedule:manage", {
      id: schedule?.id,
      name: schedule?.name,
      type: "schedule",
    });
  }

  function collectionTarget(): AuditTarget {
    return { id: "schedule_collection", type: "schedule_collection" };
  }
}
