import type { CurrentUser } from "@rakkr/shared";

export function uploadRunnerPanelPermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canRead: permissions.includes("recording:read"),
    canRun: permissions.includes("recording:control"),
  };
}
