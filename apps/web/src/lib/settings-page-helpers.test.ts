import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { settingsPagePermissions } from "./settings-page-helpers";

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
