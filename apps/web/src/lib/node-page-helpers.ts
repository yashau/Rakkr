import type { Permission } from "@rakkr/shared";

export interface NodePageActionPermissions {
  canRead: boolean;
  canReadHealth: boolean;
  canListen: boolean;
  canManage: boolean;
}

export function nodePageActionPermissions(permissions: readonly Permission[]) {
  return {
    canRead: permissions.includes("node:read"),
    canReadHealth: permissions.includes("health:read"),
    canListen: permissions.includes("listen:monitor"),
    canManage: permissions.includes("node:manage"),
  } satisfies NodePageActionPermissions;
}

export function rotateNodeTokenTitle(canManage: boolean, isPersistedNode: boolean) {
  if (!canManage) {
    return "Requires node manage";
  }

  return isPersistedNode ? "Rotate node token" : "Demo node tokens are not persisted";
}
