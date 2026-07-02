import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser } from "@rakkr/shared";
import { LocalAuthService } from "../src/auth-service.js";

process.env.RAKKR_LOCAL_ADMIN_GROUPS = "";

test("access policy decisions prefer denies over matching allows", async () => {
  const service = new LocalAuthService("");
  const user = accessUser({
    groups: [{ id: "operators", name: "Operators" }],
    id: "user_operator",
  });

  await service.updateLocalAccessPolicies(
    [
      {
        effect: "allow",
        resourceId: "node_room_alpha",
        resourceType: "node",
        subjectType: "everyone",
      },
      {
        effect: "deny",
        reason: "maintenance_hold",
        resourceId: "node_room_alpha",
        resourceType: "node",
        subjectId: "operators",
        subjectType: "group",
      },
    ],
    "user_owner",
  );

  const decision = await service.accessPolicyDecision(user, [
    { id: "node_room_alpha", type: "node" },
  ]);

  assert.equal(decision?.effect, "deny");
  assert.equal(decision?.policy.reason, "maintenance_hold");
});

test("access policy decisions match user group and wildcard recorder scopes", async () => {
  const service = new LocalAuthService("");
  const user = accessUser({
    email: "room-viewer@example.com",
    groups: [{ id: "room_viewers", name: "Room Viewers" }],
    id: "user_room_viewer",
  });

  await service.updateLocalAccessPolicies(
    [
      {
        effect: "allow",
        resourceId: "room_alpha",
        resourceType: "room",
        subjectId: "room_viewers",
        subjectType: "group",
      },
      {
        effect: "deny",
        resourceId: "node_secret",
        resourceType: "node",
        subjectType: "everyone",
      },
    ],
    "user_owner",
  );

  const roomDecision = await service.accessPolicyDecision(user, [
    { id: "node_room_alpha", type: "node" },
    { id: "room_alpha", type: "room" },
  ]);
  const deniedNodeDecision = await service.accessPolicyDecision(user, [
    { id: "node_secret", type: "node" },
    { id: "room_alpha", type: "room" },
  ]);

  assert.equal(roomDecision?.effect, "allow");
  assert.equal(roomDecision?.policy.resourceType, "room");
  assert.equal(deniedNodeDecision?.effect, "deny");
  assert.equal(deniedNodeDecision?.policy.resourceId, "node_secret");
});

test("group create slugs the name, suffixes collisions, and tracks membership", async () => {
  const service = new LocalAuthService("");
  const admin = await service.localAdmin();

  const first = await service.groups.createGroup({
    description: "Ops",
    memberIds: [admin.id],
    name: "Room Operators",
  });

  assert.equal(first.id, "room-operators", "id is a name-derived slug");
  assert.equal(first.memberCount, 1);
  assert.equal(first.members[0]?.id, admin.id);

  const second = await service.groups.createGroup({ memberIds: [], name: "Room Operators" });

  assert.equal(second.id, "room-operators-2", "a colliding slug is suffixed");

  const adminGroups = (await service.localUser(admin.id))?.groups ?? [];

  assert.ok(
    adminGroups.some((group) => group.id === "room-operators"),
    "membership is reflected in the member's resolved groups",
  );
});

test("group rename keeps the id and updates a member's resolved group name", async () => {
  const service = new LocalAuthService("");
  const admin = await service.localAdmin();
  const group = await service.groups.createGroup({ memberIds: [admin.id], name: "Room Operators" });

  const renamed = await service.groups.updateGroup(group.id, { name: "Operators" });

  assert.equal(renamed?.id, group.id, "id is immutable across rename");

  const adminGroups = (await service.localUser(admin.id))?.groups ?? [];

  assert.equal(
    adminGroups.find((entry) => entry.id === group.id)?.name,
    "Operators",
    "the member sees the new group name",
  );
});

test("group delete removes membership and its group-subject access policies", async () => {
  const service = new LocalAuthService("");
  const admin = await service.localAdmin();
  const group = await service.groups.createGroup({ memberIds: [admin.id], name: "Room Operators" });

  await service.updateLocalAccessPolicies(
    [
      {
        effect: "allow",
        resourceId: "room_alpha",
        resourceType: "room",
        subjectId: group.id,
        subjectType: "group",
      },
    ],
    "user_owner",
  );

  const deleted = await service.groups.deleteGroup(group.id);

  assert.equal(deleted?.id, group.id);
  assert.equal(await service.groups.group(group.id), undefined, "the group is gone");

  const policies = await service.accessPolicies();

  assert.ok(
    !policies.some((policy) => policy.subjectId === group.id),
    "group-subject access policies are cascade-cleaned",
  );

  const adminGroups = (await service.localUser(admin.id))?.groups ?? [];

  assert.ok(
    !adminGroups.some((entry) => entry.id === group.id),
    "the member no longer belongs to the deleted group",
  );
});

function accessUser(input: {
  email?: string;
  groups?: CurrentUser["groups"];
  id: string;
}): CurrentUser {
  return {
    email: input.email ?? `${input.id}@example.com`,
    groups: input.groups ?? [],
    id: input.id,
    name: input.id,
    permissions: ["recording:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
