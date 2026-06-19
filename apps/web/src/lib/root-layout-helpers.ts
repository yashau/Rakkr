import type { CurrentUser } from "@rakkr/shared";

export function rootLayoutPermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canCreateRecording: permissions.includes("recording:create"),
    canManageAccess: permissions.includes("auth:manage"),
    canReadAudit: permissions.includes("audit:read"),
    canReadDashboard: permissions.includes("node:read"),
    canReadNodes: permissions.includes("node:read"),
    canReadRecordings: permissions.includes("recording:read"),
    canReadSchedules: permissions.includes("schedule:read"),
    canReadSettings: permissions.includes("settings:read"),
  };
}
