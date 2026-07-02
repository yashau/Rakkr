import assert from "node:assert/strict";
import test from "node:test";

import {
  addMonths,
  buildMonthGrid,
  groupByLocalDay,
  localDayIso,
  monthGridRange,
  moveStartToDay,
  orderedWeekdayLabels,
} from "./calendar-grid";

// June 2026: the 1st is a Monday.
const JUNE = 5;

test("orderedWeekdayLabels rotates to the configured start day", () => {
  assert.deepEqual(orderedWeekdayLabels(1), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.deepEqual(orderedWeekdayLabels(0), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  assert.deepEqual(orderedWeekdayLabels(6), ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]);
});

test("buildMonthGrid starts on Monday when weekStartsOn=1", () => {
  const grid = buildMonthGrid(2026, JUNE, 1);

  assert.equal(grid.length, 6);
  assert.equal(grid[0].length, 7);
  assert.equal(grid[0][0].iso, "2026-06-01");
  assert.equal(grid[0][0].inMonth, true);
});

test("buildMonthGrid starts on Sunday when weekStartsOn=0", () => {
  const grid = buildMonthGrid(2026, JUNE, 0);

  // Sunday before June 1 2026 is May 31 (out of month), then June 1.
  assert.equal(grid[0][0].iso, "2026-05-31");
  assert.equal(grid[0][0].inMonth, false);
  assert.equal(grid[0][1].iso, "2026-06-01");
});

test("buildMonthGrid flags today", () => {
  const grid = buildMonthGrid(2026, JUNE, 1, new Date(2026, JUNE, 15));
  const today = grid.flat().find((cell) => cell.iso === "2026-06-15");

  assert.equal(today?.isToday, true);
});

test("monthGridRange spans the whole visible grid", () => {
  const range = monthGridRange(2026, JUNE, 1);

  assert.equal(localDayIso(range.start), "2026-06-01");
  assert.equal(localDayIso(range.end), "2026-07-12");
});

test("groupByLocalDay buckets by local calendar day", () => {
  const start = new Date(2026, JUNE, 15, 9, 0, 0);
  const grouped = groupByLocalDay([{ recordingStartAt: start.toISOString(), scheduleId: "s" }]);

  assert.equal(grouped.get("2026-06-15")?.length, 1);
});

test("moveStartToDay keeps the local time-of-day on the new day", () => {
  const original = new Date(2026, JUNE, 15, 14, 30, 0).toISOString();

  assert.equal(moveStartToDay(original, "2026-06-20"), new Date(2026, JUNE, 20, 14, 30, 0).toISOString());
});

test("addMonths wraps across year boundaries", () => {
  assert.deepEqual(addMonths(2026, 11, 1), { month: 0, year: 2027 });
  assert.deepEqual(addMonths(2026, 0, -1), { month: 11, year: 2025 });
});
