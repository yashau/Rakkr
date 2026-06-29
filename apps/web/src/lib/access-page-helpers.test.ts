import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser } from "@rakkr/shared";

import {
  accessDraftFromUser,
  accessPagePermissions,
  accessUpdateFromDraft,
  appendTextLine,
  canManageAccessPage,
  createInputFromDraft,
  createUserDraftValid,
  emptyCreateUserDraft,
  grantsFromText,
  groupIdsFromText,
  groupsToText,
  policiesFromText,
  policiesToText,
} from "./access-page-helpers";

test("access page management requires auth manage permission", () => {
  assert.equal(canManageAccessPage(undefined), false);
  assert.equal(canManageAccessPage(user(["audit:read"])), false);
  assert.equal(canManageAccessPage(user(["auth:manage"])), true);
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

test("groupIdsFromText splits, trims, and de-duplicates", () => {
  assert.deepEqual(groupIdsFromText("operators, viewers\noperators"), ["operators", "viewers"]);
  assert.deepEqual(groupIdsFromText("  "), []);
});

test("grantsFromText parses typed tokens and defaults bare ids to node", () => {
  assert.deepEqual(grantsFromText("node:n1\nroom:r1"), [
    { resourceId: "n1", resourceType: "node" },
    { resourceId: "r1", resourceType: "room" },
  ]);
  assert.deepEqual(grantsFromText("bare-id"), [{ resourceId: "bare-id", resourceType: "node" }]);
  assert.deepEqual(grantsFromText("\n  \n"), []);
});

test("groupsToText renders group ids one per line", () => {
  assert.equal(
    groupsToText([
      { id: "g1", name: "Ops" },
      { id: "g2", name: "Viewers" },
    ]),
    "g1\ng2",
  );
});

test("accessUpdateFromDraft falls back to viewer when no roles selected", () => {
  assert.deepEqual(accessUpdateFromDraft({ groupsText: "g1", grantsText: "node:n1", roles: [] }), {
    groupIds: ["g1"],
    resourceGrants: [{ resourceId: "n1", resourceType: "node" }],
    roles: ["viewer"],
  });
  assert.deepEqual(
    accessUpdateFromDraft({ groupsText: "", grantsText: "", roles: ["admin"] }).roles,
    ["admin"],
  );
});

test("createInputFromDraft trims identity fields and preserves the password", () => {
  assert.deepEqual(
    createInputFromDraft({
      email: "  a@b.test ",
      groupsText: "g1\ng1",
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
    { groupsText: "ops", grantsText: "node:n1", roles: ["operator"] },
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
