import type { CurrentUser } from "@rakkr/shared";

export function auditPagePermissions(user: CurrentUser | undefined) {
  const canRead = user?.permissions.includes("audit:read") ?? false;

  return {
    canExport: canRead,
    canRead,
  };
}
