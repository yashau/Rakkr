import type { Permission, ScheduleSummary } from "@rakkr/shared";

export interface SchedulePageActionPermissions {
  canRead: boolean;
  canReadAudit: boolean;
  canReadNodes: boolean;
  canManage: boolean;
}

export interface ScheduleActionState {
  canDelete: boolean;
  canEdit: boolean;
  canRunNow: boolean;
  canSkipNext: boolean;
}

export function schedulePageActionPermissions(permissions: readonly Permission[]) {
  return {
    canRead: permissions.includes("schedule:read"),
    canReadAudit: permissions.includes("audit:read"),
    canReadNodes: permissions.includes("node:read"),
    canManage: permissions.includes("schedule:manage"),
  } satisfies SchedulePageActionPermissions;
}

export function scheduleActionState(
  schedule: ScheduleSummary,
  permissions: SchedulePageActionPermissions,
): ScheduleActionState {
  return {
    canDelete: permissions.canManage,
    canEdit: permissions.canManage,
    canRunNow: permissions.canManage && schedule.enabled,
    canSkipNext: permissions.canManage && schedule.enabled && Boolean(schedule.nextRunAt),
  };
}
