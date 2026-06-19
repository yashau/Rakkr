import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser } from "@rakkr/shared";

import { canManageAccessPage } from "./access-page-helpers";

test("access page management requires auth manage permission", () => {
  assert.equal(canManageAccessPage(undefined), false);
  assert.equal(canManageAccessPage(user(["audit:read"])), false);
  assert.equal(canManageAccessPage(user(["auth:manage"])), true);
});

function user(permissions: CurrentUser["permissions"]): CurrentUser {
  return {
    email: "admin@example.test",
    groups: [],
    id: "user_test",
    name: "Admin",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["admin"],
  };
}
