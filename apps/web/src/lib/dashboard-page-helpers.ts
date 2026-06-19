import type { CurrentUser } from "@rakkr/shared";

export function dashboardPagePermissions(user: CurrentUser | undefined) {
  const canRead = user?.permissions.includes("node:read") ?? false;

  return {
    canRead,
    canReadMeters: canRead,
  };
}
