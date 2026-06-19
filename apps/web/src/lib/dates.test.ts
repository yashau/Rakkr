import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDate,
  formatDateTime,
  isoFromLocalDateTime,
  localDateBoundaryIso,
  localDateTimeInput,
  localIsoDate,
  startOfLocalDay,
} from "./dates";

test("formats displayed dates year first in local browser time", () => {
  const localDate = new Date(2026, 5, 18, 9, 5);

  assert.equal(formatDateTime(localDate.toISOString()), "2026-06-18 09:05");
  assert.equal(formatDate(localDate), "2026-06-18");
  assert.equal(localIsoDate(localDate), "2026-06-18");
});

test("converts local date inputs to ISO UTC bounds", () => {
  const start = localDateBoundaryIso("2026-06-18", "start");
  const end = localDateBoundaryIso("2026-06-18", "end");

  assert.equal(start, new Date(2026, 5, 18, 0, 0, 0, 0).toISOString());
  assert.equal(end, new Date(2026, 5, 18, 23, 59, 59, 999).toISOString());
  assert.equal(localDateBoundaryIso("", "start"), undefined);
  assert.equal(localDateBoundaryIso("bad-date", "end"), undefined);
});

test("round trips local datetime input controls through ISO timestamps", () => {
  const local = "2026-06-18T14:45";
  const iso = isoFromLocalDateTime(local);

  assert.equal(localDateTimeInput(iso), local);
});

test("computes local day starts without shifting display dates", () => {
  const start = startOfLocalDay(new Date(2026, 5, 18, 22, 30));

  assert.equal(formatDateTime(start), "2026-06-18 00:00");
});
