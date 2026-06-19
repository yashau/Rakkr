import type { CurrentUser } from "@rakkr/shared";

export function settingsPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canManageSettings: permissions.includes("settings:manage"),
    canReadNodes: permissions.includes("node:read"),
    canReadSettings: permissions.includes("settings:read"),
  };
}
