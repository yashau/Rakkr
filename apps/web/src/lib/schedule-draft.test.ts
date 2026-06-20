import assert from "node:assert/strict";
import test from "node:test";

import {
  addPauseRangeToDraft,
  applyNaturalLanguageSchedule,
  defaultDraft,
  draftToInput,
  scheduleToDraft,
} from "./schedule-draft";

test("schedule quick phrases produce structured weekly recurrence", () => {
  const draft = defaultDraft();
  const updated = applyNaturalLanguageSchedule(draft, "weekdays 9am to 10:30am");

  assert.ok(updated);
  assert.equal(updated.recurrenceMode, "weekly");
  assert.deepEqual(updated.daysOfWeek, ["monday", "tuesday", "wednesday", "thursday", "friday"]);
  assert.equal(updated.startTime, "09:00");
  assert.equal(updated.endTime, "10:30");

  const input = draftToInput({
    ...updated,
    name: "Morning Voice Capture",
    nodeId: "node_schedule_ui_test",
    room: "Council Chamber",
  });

  assert.deepEqual(input.recurrence, {
    daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    endTime: "10:30",
    interval: 1,
    mode: "weekly",
    startTime: "09:00",
  });
});

test("schedule quick phrases map always-on and monthly day rules", () => {
  const alwaysOn = applyNaturalLanguageSchedule(defaultDraft(), "always on");
  const monthly = applyNaturalLanguageSchedule(defaultDraft(), "monthly day 31 8:15 to 9:00");

  assert.equal(alwaysOn?.recurrenceMode, "always_on");
  assert.equal(monthly?.recurrenceMode, "monthly");
  assert.equal(monthly?.dayOfMonth, 31);
  assert.equal(monthly?.startTime, "08:15");
  assert.equal(monthly?.endTime, "09:00");
});

test("schedule pause ranges normalize reversed dates", () => {
  const draft = {
    ...defaultDraft(),
    pauseEndDate: "2026-06-10",
    pauseReason: "Room maintenance",
    pauseStartDate: "2026-06-12",
  };

  const updated = addPauseRangeToDraft(draft);

  assert.deepEqual(updated.exceptions, [
    {
      action: "pause",
      endDate: "2026-06-12",
      reason: "Room maintenance",
      startDate: "2026-06-10",
    },
  ]);
});

test("schedule backend draft round trips pinned and default values", () => {
  const pinnedInput = draftToInput({
    ...defaultDraft(),
    captureBackend: "jack",
    captureInterfaceId: "iface_jack",
    name: "Council JACK Capture",
    nodeId: "node_schedule_backend_test",
    room: "Council Chamber",
  });
  const defaultInput = draftToInput({
    ...defaultDraft(),
    captureBackend: "",
    captureInterfaceId: "",
    name: "Council Default Capture",
    nodeId: "node_schedule_backend_test",
    room: "Council Chamber",
  });
  const draft = scheduleToDraft({
    ...pinnedInput,
    captureBackend: "pipewire",
    captureInterfaceId: "iface_pipewire",
    id: "sched_backend_test",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    recurrence: { mode: "manual" },
    tags: [],
  });

  assert.equal(pinnedInput.captureBackend, "jack");
  assert.equal(pinnedInput.captureInterfaceId, "iface_jack");
  assert.equal(defaultInput.captureBackend, null);
  assert.equal(defaultInput.captureInterfaceId, null);
  assert.equal(draft.captureBackend, "pipewire");
  assert.equal(draft.captureInterfaceId, "iface_pipewire");
});
