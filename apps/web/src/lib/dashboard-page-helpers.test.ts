import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { dashboardPagePermissions } from "./dashboard-page-helpers";

test("dashboard page reads and meters require node read permission", () => {
  assert.deepEqual(dashboardPagePermissions(undefined), {
    canRead: false,
    canReadMeters: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["metrics:read"])), {
    canRead: false,
    canReadMeters: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["node:read"])), {
    canRead: true,
    canReadMeters: true,
  });
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
