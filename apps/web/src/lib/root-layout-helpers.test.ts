import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { rootLayoutNavItems, rootLayoutPermissions } from "./root-layout-helpers";

test("root layout permissions are closed by default", () => {
  assert.deepEqual(rootLayoutPermissions(undefined), {
    canCreateRecording: false,
    canManageAccess: false,
    canReadAudit: false,
    canReadDashboard: false,
    canReadNodes: false,
    canReadRecordings: false,
    canReadSchedules: false,
    canReadSettings: false,
  });
});

test("root layout separates navigation and header action permissions", () => {
  assert.deepEqual(rootLayoutPermissions(user(["node:read", "recording:create"])), {
    canCreateRecording: true,
    canManageAccess: false,
    canReadAudit: false,
    canReadDashboard: true,
    canReadNodes: true,
    canReadRecordings: false,
    canReadSchedules: false,
    canReadSettings: false,
  });
  assert.deepEqual(
    rootLayoutPermissions(
      user([
        "audit:read",
        "auth:manage",
        "node:read",
        "recording:read",
        "schedule:read",
        "settings:read",
      ]),
    ),
    {
      canCreateRecording: false,
      canManageAccess: true,
      canReadAudit: true,
      canReadDashboard: true,
      canReadNodes: true,
      canReadRecordings: true,
      canReadSchedules: true,
      canReadSettings: true,
    },
  );
});

test("root layout nav items only include permitted sections", () => {
  assert.deepEqual(rootLayoutNavItems(rootLayoutPermissions(user(["recording:create"]))), []);
  assert.deepEqual(
    rootLayoutNavItems(
      rootLayoutPermissions(
        user(["audit:read", "auth:manage", "node:read", "recording:read", "settings:read"]),
      ),
    ),
    [
      { id: "dashboard", label: "Dashboard", to: "/" },
      { id: "nodes", label: "Nodes", to: "/nodes" },
      { id: "recordings", label: "Recordings", to: "/recordings" },
      { id: "settings", label: "Settings", to: "/settings" },
      { id: "audit", label: "Audit", to: "/audit" },
      { id: "access", label: "Access", to: "/access" },
    ],
  );
  assert.deepEqual(rootLayoutNavItems(rootLayoutPermissions(user(["schedule:read"]))), [
    { id: "schedules", label: "Schedules", to: "/schedules" },
  ]);
});

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "operator@example.test",
    groups: [],
    id: "user_operator",
    name: "Operator",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
