import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { rootLayoutPermissions } from "./root-layout-helpers";

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
