import type { CurrentUser } from "@rakkr/shared";

export function settingsPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canManageSettings: permissions.includes("settings:manage"),
    canReadNodes: permissions.includes("node:read"),
    canReadSettings: permissions.includes("settings:read"),
  };
}

export function watchdogCalibrationActionState({
  canManageSettings,
  canReadNodes,
  nodeCount,
}: {
  canManageSettings: boolean;
  canReadNodes: boolean;
  nodeCount: number;
}) {
  if (!canManageSettings) {
    return {
      disabled: true,
      title: "Requires settings manage",
    };
  }

  if (!canReadNodes) {
    return {
      disabled: true,
      title: "Requires node read",
    };
  }

  if (nodeCount === 0) {
    return {
      disabled: true,
      title: "No nodes available",
    };
  }

  return {
    disabled: false,
    title: "Calibrate watchdog from room meter history",
  };
}
