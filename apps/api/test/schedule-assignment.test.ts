import assert from "node:assert/strict";
import test from "node:test";
import type { Permission } from "@rakkr/shared";
import {
  ASSIGNMENT_CAPABILITIES,
  assignedRoomKeysFor,
  compositeRoomKey,
  nodeInAssignedRoom,
  roomTargetsMatchAssignedKeys,
  scheduleAssignsUser,
} from "../src/schedule-assignment.js";

function sched(overrides: Partial<Parameters<typeof scheduleAssignsUser>[0]> = {}) {
  return { assignedGroupIds: [], assignedUserIds: [], nodeId: "node-a", ...overrides };
}

function node(id: string, site: string, room: string) {
  return { id, location: { room, site } };
}

const user = { groups: [{ id: "grp-ops" }], id: "user-1" };

test("scheduleAssignsUser matches a direct user assignment", () => {
  assert.equal(scheduleAssignsUser(sched({ assignedUserIds: ["user-1"] }), user), true);
  assert.equal(scheduleAssignsUser(sched({ assignedUserIds: ["user-2"] }), user), false);
});

test("scheduleAssignsUser matches via an access group", () => {
  assert.equal(scheduleAssignsUser(sched({ assignedGroupIds: ["grp-ops"] }), user), true);
  assert.equal(scheduleAssignsUser(sched({ assignedGroupIds: ["grp-other"] }), user), false);
});

test("scheduleAssignsUser is false with no assignment", () => {
  assert.equal(scheduleAssignsUser(sched(), user), false);
});

test("compositeRoomKey requires both site and room", () => {
  assert.equal(compositeRoomKey("HQ", "Studio A"), "HQ/Studio A");
  assert.equal(compositeRoomKey("", "Studio A"), undefined);
  assert.equal(compositeRoomKey("HQ", undefined), undefined);
});

test("assignedRoomKeysFor keys on each assigned schedule's node room", () => {
  const nodes = [node("node-a", "HQ", "Studio A"), node("node-b", "HQ", "Studio B")];
  const schedules = [
    sched({ assignedUserIds: ["user-1"], nodeId: "node-a" }),
    sched({ assignedGroupIds: ["grp-ops"], nodeId: "node-b" }),
    sched({ nodeId: "node-a" }), // present but not assigned to this user
  ];

  assert.deepEqual([...assignedRoomKeysFor(schedules, nodes, user)].sort(), [
    "HQ/Studio A",
    "HQ/Studio B",
  ]);
});

test("assignedRoomKeysFor ignores unknown nodes and nodes missing a site/room", () => {
  const nodes = [node("node-a", "", "Studio A"), node("node-c", "HQ", "Studio C")];
  const schedules = [
    sched({ assignedUserIds: ["user-1"], nodeId: "node-a" }), // no site -> no key
    sched({ assignedUserIds: ["user-1"], nodeId: "ghost" }), // unknown node -> skipped
    sched({ assignedUserIds: ["user-1"], nodeId: "node-c" }),
  ];

  assert.deepEqual([...assignedRoomKeysFor(schedules, nodes, user)], ["HQ/Studio C"]);
});

test("assignedRoomKeysFor returns an empty set when the user is assigned to nothing", () => {
  const nodes = [node("node-a", "HQ", "Studio A")];

  assert.equal(assignedRoomKeysFor([sched()], nodes, user).size, 0);
});

test("nodeInAssignedRoom matches only the exact site+room", () => {
  const keys = new Set(["HQ/Studio A"]);

  assert.equal(nodeInAssignedRoom(node("n", "HQ", "Studio A"), keys), true);
  assert.equal(nodeInAssignedRoom(node("n", "HQ", "Studio B"), keys), false);
  assert.equal(nodeInAssignedRoom(node("n", "Annex", "Studio A"), keys), false);
});

test("roomTargetsMatchAssignedKeys only matches composite room targets", () => {
  const keys = new Set(["HQ/Studio A"]);

  assert.equal(roomTargetsMatchAssignedKeys([{ id: "HQ/Studio A", type: "room" }], keys), true);

  // Bare-room and site targets must not collide with a composite key.
  assert.equal(
    roomTargetsMatchAssignedKeys(
      [
        { id: "Studio A", type: "room" },
        { id: "HQ", type: "site" },
        { id: "node-a", type: "node" },
      ],
      keys,
    ),
    false,
  );

  // No assigned rooms => never matches.
  assert.equal(
    roomTargetsMatchAssignedKeys([{ id: "HQ/Studio A", type: "room" }], new Set()),
    false,
  );
});

test("ASSIGNMENT_CAPABILITIES grants room ops but excludes global/infra permissions", () => {
  const included: Permission[] = [
    "listen:monitor",
    "recording:playback",
    "recording:download",
    "recording:read",
    "recording:control",
    "recording:create",
    "recording:edit",
    "recording:delete",
    "node:read",
    "node:control",
    "schedule:read",
    "schedule:manage",
    "health:read",
    "health:acknowledge",
  ];
  const excluded: Permission[] = [
    "auth:manage",
    "node:manage",
    "settings:manage",
    "settings:read",
    "metrics:read",
    "audit:read",
    "system:admin",
  ];

  for (const permission of included) {
    assert.equal(ASSIGNMENT_CAPABILITIES.has(permission), true, `expected ${permission} granted`);
  }

  for (const permission of excluded) {
    assert.equal(ASSIGNMENT_CAPABILITIES.has(permission), false, `expected ${permission} excluded`);
  }
});
