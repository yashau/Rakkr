import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { settingsPagePermissions, watchdogCalibrationActionState } from "./settings-page-helpers";

test("settings page permissions are closed by default", () => {
  assert.deepEqual(settingsPagePermissions(undefined), {
    canManageSettings: false,
    canReadNodes: false,
    canReadSettings: false,
  });
});

test("settings page separates settings read manage and node lookup permissions", () => {
  assert.deepEqual(settingsPagePermissions(user(["settings:read"])), {
    canManageSettings: false,
    canReadNodes: false,
    canReadSettings: true,
  });
  assert.deepEqual(settingsPagePermissions(user(["node:read", "settings:read"])), {
    canManageSettings: false,
    canReadNodes: true,
    canReadSettings: true,
  });
  assert.deepEqual(
    settingsPagePermissions(user(["node:read", "settings:manage", "settings:read"])),
    {
      canManageSettings: true,
      canReadNodes: true,
      canReadSettings: true,
    },
  );
});

test("watchdog calibration action requires settings manage node read and nodes", () => {
  assert.deepEqual(
    watchdogCalibrationActionState({
      canManageSettings: false,
      canReadNodes: true,
      nodeCount: 1,
    }),
    {
      disabled: true,
      title: "Requires settings manage",
    },
  );
  assert.deepEqual(
    watchdogCalibrationActionState({
      canManageSettings: true,
      canReadNodes: false,
      nodeCount: 1,
    }),
    {
      disabled: true,
      title: "Requires node read",
    },
  );
  assert.deepEqual(
    watchdogCalibrationActionState({
      canManageSettings: true,
      canReadNodes: true,
      nodeCount: 0,
    }),
    {
      disabled: true,
      title: "No nodes available",
    },
  );
  assert.deepEqual(
    watchdogCalibrationActionState({
      canManageSettings: true,
      canReadNodes: true,
      nodeCount: 1,
    }),
    {
      disabled: false,
      title: "Calibrate watchdog from room meter history",
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
