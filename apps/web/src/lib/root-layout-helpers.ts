import type { CurrentUser } from "@rakkr/shared";

export type RootLayoutPermissions = ReturnType<typeof rootLayoutPermissions>;

export type RootNavItem = {
  id:
    | "access"
    | "audit"
    | "dashboard"
    | "health"
    | "jobs"
    | "nodes"
    | "recordings"
    | "rooms"
    | "schedules"
    | "settings";
  label: string;
  to:
    | "/"
    | "/access"
    | "/audit"
    | "/health"
    | "/jobs"
    | "/nodes"
    | "/recordings"
    | "/rooms"
    | "/schedules"
    | "/settings";
};

export function rootLayoutPermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canCreateRecording: permissions.includes("recording:create"),
    canManageAccess: permissions.includes("auth:manage"),
    canReadAudit: permissions.includes("audit:read"),
    canReadDashboard: permissions.includes("node:read"),
    canReadHealth: permissions.includes("health:read"),
    canReadJobs: permissions.includes("recording:read"),
    canReadNodes: permissions.includes("node:read"),
    canReadRecordings: permissions.includes("recording:read"),
    canReadRooms: permissions.includes("node:read"),
    canReadSchedules: permissions.includes("schedule:read"),
    canReadSettings: permissions.includes("settings:read"),
  };
}

export function rootLayoutNavItems(permissions: RootLayoutPermissions): RootNavItem[] {
  return [
    ...(permissions.canReadDashboard ? [navItem("dashboard", "Dashboard", "/")] : []),
    ...(permissions.canReadNodes ? [navItem("nodes", "Nodes", "/nodes")] : []),
    ...(permissions.canReadRooms ? [navItem("rooms", "Rooms", "/rooms")] : []),
    ...(permissions.canReadHealth ? [navItem("health", "Health", "/health")] : []),
    ...(permissions.canReadSchedules ? [navItem("schedules", "Schedules", "/schedules")] : []),
    ...(permissions.canReadRecordings ? [navItem("recordings", "Recordings", "/recordings")] : []),
    ...(permissions.canReadJobs ? [navItem("jobs", "Jobs", "/jobs")] : []),
    ...(permissions.canReadSettings ? [navItem("settings", "Settings", "/settings")] : []),
    ...(permissions.canReadAudit ? [navItem("audit", "Audit", "/audit")] : []),
    ...(permissions.canManageAccess ? [navItem("access", "Access", "/access")] : []),
  ];
}

export function rootLayoutRecordActionState(permissions: RootLayoutPermissions) {
  if (!permissions.canCreateRecording) {
    return {
      canOpen: false,
      title: "Requires recording create",
    };
  }

  if (!permissions.canReadNodes) {
    return {
      canOpen: false,
      title: "Requires node read",
    };
  }

  if (!permissions.canReadSettings) {
    return {
      canOpen: false,
      title: "Requires settings read",
    };
  }

  return {
    canOpen: true,
    title: "Start recording",
  };
}

function navItem(id: RootNavItem["id"], label: RootNavItem["label"], to: RootNavItem["to"]) {
  return { id, label, to };
}
