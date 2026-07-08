import assert from "node:assert/strict";
import test from "node:test";
import { scheduleInputSchema, scheduleUpdateSchema } from "@rakkr/shared";
import { buildSchedule, sanitizeScheduleUpdate } from "../src/schedule-route-helpers.js";

const baseInput = (overrides: Record<string, unknown> = {}) =>
  scheduleInputSchema.parse({
    folderTemplate: "recordings/{room}",
    name: "Council Capture",
    nodeId: "node_1",
    recordingProfileId: "profile_voice",
    room: "Council Room",
    timezone: "UTC",
    titleTemplate: "{room}",
    watchdogPolicyId: "watchdog_default",
    ...overrides,
  });

test("buildSchedule dedups uploadPolicyIds so a recording fans out once per destination", () => {
  // A recording fans out to one upload queue item per id; duplicates would
  // double the upload work, so the server dedups (client also dedups) — R4-1.
  const schedule = buildSchedule(baseInput({ uploadPolicyIds: ["up_a", "up_a", "up_b", "up_b"] }));

  assert.deepEqual(schedule.uploadPolicyIds, ["up_a", "up_b"]);
});

test("sanitizeScheduleUpdate dedups uploadPolicyIds on patch", () => {
  const before = buildSchedule(baseInput({ uploadPolicyIds: ["up_a"] }));
  const update = scheduleUpdateSchema.parse({ uploadPolicyIds: ["up_x", "up_x", "up_y", "up_x"] });

  const updates = sanitizeScheduleUpdate(update, before);

  assert.deepEqual(updates.uploadPolicyIds, ["up_x", "up_y"]);
});

test("sanitizeScheduleUpdate leaves uploadPolicyIds untouched when the field is absent", () => {
  const before = buildSchedule(baseInput({ uploadPolicyIds: ["up_a", "up_b"] }));
  const update = scheduleUpdateSchema.parse({ name: "Renamed" });

  const updates = sanitizeScheduleUpdate(update, before);

  assert.equal("uploadPolicyIds" in updates, false);
  assert.equal(updates.name, "Renamed");
});
