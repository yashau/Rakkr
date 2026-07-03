import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser } from "@rakkr/shared";

import {
  accessDraftFromUser,
  accessPagePermissions,
  accessUpdateFromDraft,
  appendTextLine,
  canManageAccessPage,
  canResetUserPassword,
  createInputFromDraft,
  createUserDraftValid,
  emptyCreateUserDraft,
  grantsFromText,
  policiesFromText,
  policiesToText,
  SUBJECT_PICKER_LIMIT,
  subjectPickerFilters,
  subjectPickerGroupsQueryKey,
  subjectPickerUsersQueryKey,
} from "./access-page-helpers";

test("access page management requires auth manage permission", () => {
  assert.equal(canManageAccessPage(undefined), false);
  assert.equal(canManageAccessPage(user(["audit:read"])), false);
  assert.equal(canManageAccessPage(user(["auth:manage"])), true);
});

test("subject pickers fetch the full list and use collision-safe query keys", () => {
  // Must fetch up to the server cap (200), not the 50-row default page, so groups
  // and users beyond the first page are reachable in the picker.
  assert.equal(SUBJECT_PICKER_LIMIT, 200);
  assert.deepEqual(subjectPickerFilters(), { limit: 200 });
  // Keys are params-suffixed (length 2), so they do NOT share the bare
  // ["access-groups"] / ["access-users"] slot used by the management views.
  assert.deepEqual(subjectPickerGroupsQueryKey(), ["access-groups", { limit: 200 }]);
  assert.deepEqual(subjectPickerUsersQueryKey(), ["access-users", { limit: 200 }]);
});

test("access page permissions track the auth manage permission", () => {
  assert.deepEqual(accessPagePermissions(undefined), { canManage: false, canRead: false });
  assert.deepEqual(accessPagePermissions(user(["audit:read"])), {
    canManage: false,
    canRead: false,
  });
  assert.deepEqual(accessPagePermissions(user(["auth:manage"])), {
    canManage: true,
    canRead: true,
  });
});

test("create user draft validity requires email, name, and an 8+ char password", () => {
  assert.equal(createUserDraftValid(emptyCreateUserDraft), false);
  assert.equal(
    createUserDraftValid({
      ...emptyCreateUserDraft,
      email: "a@b.test",
      name: "A",
      password: "short",
    }),
    false,
  );
  assert.equal(
    createUserDraftValid({
      ...emptyCreateUserDraft,
      email: "  ",
      name: "A",
      password: "longenough",
    }),
    false,
  );
  assert.equal(
    createUserDraftValid({
      ...emptyCreateUserDraft,
      email: "a@b.test",
      name: "Ada",
      password: "longenough",
    }),
    true,
  );
});

test("appendTextLine joins onto trimmed existing content", () => {
  assert.equal(appendTextLine("", "node:n1"), "node:n1");
  assert.equal(appendTextLine("  ", "node:n1"), "node:n1");
  assert.equal(appendTextLine("node:n1", "room:r1"), "node:n1\nroom:r1");
  assert.equal(appendTextLine("node:n1\n", "room:r1"), "node:n1\nroom:r1");
});

test("grantsFromText parses typed tokens and defaults bare ids to node", () => {
  assert.deepEqual(grantsFromText("node:n1\nroom:r1"), [
    { resourceId: "n1", resourceType: "node" },
    { resourceId: "r1", resourceType: "room" },
  ]);
  assert.deepEqual(grantsFromText("bare-id"), [{ resourceId: "bare-id", resourceType: "node" }]);
  assert.deepEqual(grantsFromText("\n  \n"), []);
});

test("accessUpdateFromDraft falls back to viewer when no roles selected", () => {
  assert.deepEqual(
    accessUpdateFromDraft({ groupIds: ["g1", "g1"], grantsText: "node:n1", roles: [] }),
    {
      groupIds: ["g1"],
      resourceGrants: [{ resourceId: "n1", resourceType: "node" }],
      roles: ["viewer"],
    },
  );
  assert.deepEqual(
    accessUpdateFromDraft({ groupIds: [], grantsText: "", roles: ["admin"] }).roles,
    ["admin"],
  );
});

test("createInputFromDraft trims identity fields and preserves the password", () => {
  assert.deepEqual(
    createInputFromDraft({
      email: "  a@b.test ",
      groupIds: ["g1", "g1"],
      grantsText: "node:n1",
      name: "  Ada ",
      password: "longenough",
      roles: ["operator"],
    }),
    {
      email: "a@b.test",
      groupIds: ["g1"],
      name: "Ada",
      password: "longenough",
      resourceGrants: [{ resourceId: "n1", resourceType: "node" }],
      roles: ["operator"],
    },
  );
});

test("accessDraftFromUser projects a user onto the editable draft", () => {
  assert.deepEqual(
    accessDraftFromUser(
      user(["auth:manage"], {
        groups: [{ id: "ops", name: "Operators" }],
        resourceGrants: [{ resourceId: "n1", resourceType: "node" }],
        roles: ["operator"],
      }),
    ),
    { groupIds: ["ops"], grantsText: "node:n1", roles: ["operator"] },
  );
});

test("policies round-trip through text", () => {
  const text = "deny | everyone | node:n1\nallow | user:u1 | recording:r1 | onboarding";
  const parsed = policiesFromText(text);

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.policies, [
    {
      effect: "deny",
      reason: undefined,
      resourceId: "n1",
      resourceType: "node",
      subjectId: undefined,
      subjectType: "everyone",
    },
    {
      effect: "allow",
      reason: "onboarding",
      resourceId: "r1",
      resourceType: "recording",
      subjectId: "u1",
      subjectType: "user",
    },
  ]);

  assert.equal(
    policiesToText([
      { effect: "deny", id: "p1", resourceId: "n1", resourceType: "node", subjectType: "everyone" },
    ]),
    "deny | everyone | node:n1",
  );
});

test("policiesFromText reports invalid effect and tokens", () => {
  assert.equal(
    policiesFromText("nope | everyone | node:n1").error,
    "Line 1 must start with allow or deny.",
  );
  assert.equal(
    policiesFromText("deny | bogus | node:n1").error,
    "Line 1 has an invalid subject or resource.",
  );
});

test("G75: password reset is offered only for local users", () => {
  // The API refuses a reset for non-local providers
  // (`non_local_user_password_unavailable`), so the UI must hide the affordance
  // for OIDC-provisioned users while still offering it to local users.
  assert.equal(canResetUserPassword(user(["auth:manage"], { provider: "local" })), true);
  assert.equal(canResetUserPassword(user(["auth:manage"], { provider: "oidc" })), false);
});

function user(
  permissions: CurrentUser["permissions"],
  overrides: Partial<CurrentUser> = {},
): CurrentUser {
  return {
    email: "admin@example.test",
    groups: [],
    id: "user_test",
    name: "Admin",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["admin"],
    ...overrides,
  };
}
