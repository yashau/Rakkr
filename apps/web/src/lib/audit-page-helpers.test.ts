import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, Permission } from "@rakkr/shared";

import { auditPagePermissions } from "./audit-page-helpers";

test("audit page read and export require audit read permission", () => {
  assert.deepEqual(auditPagePermissions(undefined), {
    canExport: false,
    canRead: false,
  });
  assert.deepEqual(auditPagePermissions(user(["recording:read"])), {
    canExport: false,
    canRead: false,
  });
  assert.deepEqual(auditPagePermissions(user(["audit:read"])), {
    canExport: true,
    canRead: true,
  });
});

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "auditor@example.test",
    groups: [],
    id: "user_auditor",
    name: "Auditor",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["auditor"],
  };
}
