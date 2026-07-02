import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const storeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-room-roster-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_ROOM_ROSTER_STORE_PATH = path.join(storeRoot, "room-roster.json");

const { createRoomRosterStore } = await import("../src/room-roster-store.js");

const store = createRoomRosterStore();

test.after(async () => {
  await rm(storeRoot, { force: true, recursive: true });
});

test("replaceManual persists per-subject capabilities and effectiveCapabilities reads them", async () => {
  await store.replaceManual("room_a", [
    { capabilities: ["view", "operate"], subjectId: "user-1", subjectType: "user" },
    { capabilities: ["view"], subjectId: "group-ops", subjectType: "group" },
  ]);

  const direct = await store.effectiveCapabilities({ groupIds: [], userId: "user-1" }, "room_a");
  assert.deepEqual([...direct].sort(), ["operate", "view"]);
});

test("effectiveCapabilities unions a user's direct and group entries", async () => {
  await store.replaceManual("room_b", [
    { capabilities: ["view"], subjectId: "user-2", subjectType: "user" },
    { capabilities: ["operate", "book"], subjectId: "group-av", subjectType: "group" },
  ]);

  const effective = await store.effectiveCapabilities(
    { groupIds: ["group-av"], userId: "user-2" },
    "room_b",
  );
  assert.deepEqual([...effective].sort(), ["book", "operate", "view"]);

  // A user not in the group only gets their direct capabilities.
  const withoutGroup = await store.effectiveCapabilities(
    { groupIds: [], userId: "user-2" },
    "room_b",
  );
  assert.deepEqual([...withoutGroup], ["view"]);
});

test("replaceManual drops empty-capability entries and replaces prior manual rows", async () => {
  await store.replaceManual("room_c", [
    { capabilities: ["view"], subjectId: "user-3", subjectType: "user" },
    { capabilities: [], subjectId: "user-4", subjectType: "user" },
  ]);

  const forThree = await store.effectiveCapabilities({ groupIds: [], userId: "user-3" }, "room_c");
  const forFour = await store.effectiveCapabilities({ groupIds: [], userId: "user-4" }, "room_c");
  assert.deepEqual([...forThree], ["view"]);
  assert.equal(forFour.size, 0);

  // Replacing clears user-3.
  await store.replaceManual("room_c", []);
  const cleared = await store.effectiveCapabilities({ groupIds: [], userId: "user-3" }, "room_c");
  assert.equal(cleared.size, 0);
});

test("reconcileCalendar materializes calendar rows and removeForSchedule clears them", async () => {
  await store.reconcileCalendar({
    capabilities: ["view", "operate"],
    roomId: "room_d",
    scheduleId: "sched-1",
    subjects: [
      { subjectId: "user-5", subjectType: "user" },
      { subjectId: "group-x", subjectType: "group" },
    ],
  });

  const caps = await store.effectiveCapabilities({ groupIds: [], userId: "user-5" }, "room_d");
  assert.deepEqual([...caps].sort(), ["operate", "view"]);

  const entries = await store.listForRoom("room_d");
  assert.ok(entries.every((entry) => entry.source === "calendar"));

  await store.removeForSchedule("sched-1");
  const after = await store.effectiveCapabilities({ groupIds: [], userId: "user-5" }, "room_d");
  assert.equal(after.size, 0);
});

test("manual and calendar grants for the same subject/room merge", async () => {
  await store.replaceManual("room_e", [
    { capabilities: ["book"], subjectId: "user-6", subjectType: "user" },
  ]);
  await store.reconcileCalendar({
    capabilities: ["view", "operate"],
    roomId: "room_e",
    scheduleId: "sched-2",
    subjects: [{ subjectId: "user-6", subjectType: "user" }],
  });

  const caps = await store.effectiveCapabilities({ groupIds: [], userId: "user-6" }, "room_e");
  assert.deepEqual([...caps].sort(), ["book", "operate", "view"]);
});

test("roomsForSubject returns every room the subject holds a capability in", async () => {
  await store.replaceManual("room_f", [
    { capabilities: ["view"], subjectId: "user-7", subjectType: "user" },
  ]);
  await store.replaceManual("room_g", [
    { capabilities: ["operate"], subjectId: "group-y", subjectType: "group" },
  ]);

  const rooms = await store.roomsForSubject({ groupIds: ["group-y"], userId: "user-7" });
  assert.deepEqual([...rooms.keys()].sort(), ["room_f", "room_g"]);
  assert.deepEqual([...(rooms.get("room_g") ?? [])], ["operate"]);
});
