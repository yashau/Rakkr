import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { uploadRunnerPanelPermissions } from "./upload-runner-panel-helpers";

test("upload runner panel permissions are closed by default", () => {
  assert.deepEqual(uploadRunnerPanelPermissions(undefined), {
    canRead: false,
    canRun: false,
  });
});

test("upload runner panel separates status read from run control", () => {
  assert.deepEqual(uploadRunnerPanelPermissions(user(["recording:read"])), {
    canRead: true,
    canRun: false,
  });
  assert.deepEqual(uploadRunnerPanelPermissions(user(["recording:control"])), {
    canRead: false,
    canRun: true,
  });
  assert.deepEqual(uploadRunnerPanelPermissions(user(["recording:control", "recording:read"])), {
    canRead: true,
    canRun: true,
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
