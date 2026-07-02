import type { Permission } from "@rakkr/shared";

// Shared HATEOAS action descriptor used by the auth management + group route
// summaries. Extracted so both route modules can build actions without a cycle.
export interface AuthActionState {
  enabled: boolean;
  href?: string;
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  payload?: Record<string, unknown>;
  permission: Permission;
  reason?: string;
}

export function actionState({
  href,
  method,
  payload,
  permission,
  permissions,
  ready,
  reason,
}: {
  href?: string;
  method: AuthActionState["method"];
  payload?: Record<string, unknown>;
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): AuthActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, payload, permission }
    : { enabled: false, method, payload, permission, reason };
}
