import type { Permission } from "@rakkr/shared";

export interface NodePageActionPermissions {
  canListen: boolean;
  canManage: boolean;
}

export function nodePageActionPermissions(permissions: readonly Permission[]) {
  return {
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
