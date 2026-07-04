// Schedule CSV export routes (filtered GET + selected-ids POST), extracted from
// schedule-routes.ts to keep that module within the LOC budget. Registers on the
// passed app and mirrors the sibling schedule-route modules' deps-object pattern.

import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ScheduleSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import { scheduleExportFileName, schedulesCsv } from "./schedule-export.js";
import { filterSchedules, scheduleFilters } from "./schedule-list-filters.js";
import type { createScheduleRouteAudit } from "./schedule-route-audit.js";

const scheduleSelectedExportSchema = z
  .object({
    scheduleIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();

interface ScheduleExportRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  recordSelectedScheduleExportFailure: ReturnType<
    typeof createScheduleRouteAudit
  >["recordSelectedScheduleExportFailure"];
  requirePermission: RequirePermission;
  scopedSchedules: (user: NonNullable<AuthResult["user"]>) => Promise<ScheduleSummary[]>;
}

export function registerScheduleExportRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  recordSelectedScheduleExportFailure,
  requirePermission,
  scopedSchedules,
}: ScheduleExportRouteDependencies) {
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
}

function uniqueScheduleIds(scheduleIds: string[]) {
  return Array.from(new Set(scheduleIds));
}
