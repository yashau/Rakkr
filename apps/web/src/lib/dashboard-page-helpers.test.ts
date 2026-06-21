import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { dashboardPagePermissions, dashboardSelectedNodeId } from "./dashboard-page-helpers";

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

test("dashboard selected node stays visible or falls back to first node", () => {
  const nodes = [{ id: "node_a" }, { id: "node_b" }, { id: "node_c" }];

  assert.equal(dashboardSelectedNodeId("node_b", nodes), "node_b");
  assert.equal(dashboardSelectedNodeId("node_missing", nodes), "node_a");
  assert.equal(dashboardSelectedNodeId("", nodes), "node_a");
  assert.equal(dashboardSelectedNodeId("node_missing", []), "");
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
