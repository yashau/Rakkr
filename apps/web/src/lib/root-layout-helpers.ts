import type { CurrentUser } from "@rakkr/shared";

export type RootLayoutPermissions = ReturnType<typeof rootLayoutPermissions>;

export type RootNavItem = {
  id: "access" | "audit" | "dashboard" | "nodes" | "recordings" | "schedules" | "settings";
  label: string;
  to: "/" | "/access" | "/audit" | "/nodes" | "/recordings" | "/schedules" | "/settings";
};

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

export function rootLayoutNavItems(permissions: RootLayoutPermissions): RootNavItem[] {
  return [
    ...(permissions.canReadDashboard ? [navItem("dashboard", "Dashboard", "/")] : []),
    ...(permissions.canReadNodes ? [navItem("nodes", "Nodes", "/nodes")] : []),
    ...(permissions.canReadSchedules ? [navItem("schedules", "Schedules", "/schedules")] : []),
    ...(permissions.canReadRecordings ? [navItem("recordings", "Recordings", "/recordings")] : []),
    ...(permissions.canReadSettings ? [navItem("settings", "Settings", "/settings")] : []),
    ...(permissions.canReadAudit ? [navItem("audit", "Audit", "/audit")] : []),
    ...(permissions.canManageAccess ? [navItem("access", "Access", "/access")] : []),
  ];
}

function navItem(id: RootNavItem["id"], label: RootNavItem["label"], to: RootNavItem["to"]) {
  return { id, label, to };
}
