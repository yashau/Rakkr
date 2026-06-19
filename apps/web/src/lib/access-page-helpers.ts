import type { CurrentUser } from "@rakkr/shared";

export function canManageAccessPage(user: CurrentUser | undefined) {
  return user?.permissions.includes("auth:manage") ?? false;
}
