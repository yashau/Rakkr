// Schedule-route audit-failure recorders, extracted from schedule-routes.ts to
// keep that module within the LOC budget. Each closes over recordAuditEvent +
// currentAuth only, so they factor out cleanly behind this factory.

import type { Context } from "hono";
import type { ScheduleSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";

export function createScheduleRouteAudit({
  currentAuth,
  recordAuditEvent,
}: {
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
}) {
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

  // Shared 400 for a create/update whose channel selection spans rooms.
  async function rejectCrossRoomSelection(
    c: Context<AppBindings>,
    action: string,
    schedule?: Partial<ScheduleSummary>,
  ) {
    await recordScheduleWriteFailure(c, action, "schedule_channel_cross_room", schedule);
    return c.json(
      { error: "Channel selection spans multiple rooms", reason: "schedule_channel_cross_room" },
      400,
    );
  }

  return {
    recordScheduleReadFailure,
    recordScheduleRunFailure,
    recordScheduleWriteFailure,
    recordSelectedScheduleExportFailure,
    rejectCrossRoomSelection,
  };
}
