import assert from "node:assert/strict";
import test from "node:test";
import { ianaTimeZoneSchema, isoDateTimeSchema, meterFrameSchema } from "@rakkr/shared";
import { hashPassword, verifyPassword } from "../src/password.js";

test("meterFrameSchema caps the levels array (watchdog Math.max spread guard)", () => {
  const frame = (count: number) => ({
    capturedAt: "2026-06-18T12:00:00.000Z",
    interfaceId: "iface_1",
    levels: Array.from({ length: count }, (_unused, index) => ({
      channelIndex: index + 1,
      clipping: false,
      label: `L${index + 1}`,
      peakDbfs: -6,
      rmsDbfs: -18,
    })),
    nodeId: "node_1",
  });

  // Pre-fix an unbounded array let a hostile node wedge the watchdog with a
  // RangeError. 512 is well past any real interface's channel count.
  assert.equal(meterFrameSchema.safeParse(frame(512)).success, true);
  assert.equal(meterFrameSchema.safeParse(frame(513)).success, false);
});

test("ianaTimeZoneSchema rejects zones that would throw in Intl.DateTimeFormat", () => {
  // Valid IANA zones (and UTC) parse.
  for (const good of [
    "UTC",
    "America/New_York",
    "Europe/London",
    "Asia/Tokyo",
    "Indian/Maldives",
  ]) {
    assert.equal(ianaTimeZoneSchema.safeParse(good).success, true, good);
  }

  // Pre-fix these passed `.min(1).max(80)` and then threw
  // `RangeError: Invalid time zone specified` at `new Intl.DateTimeFormat(...,
  // { timeZone })` in buildSchedule (500 instead of 400) — buildSchedule runs
  // outside the schedule-create route's try/catch.
  for (const bad of ["Not/AZone", "Mars/Olympus", "tomorrow", "GMT+25", ""]) {
    assert.equal(ianaTimeZoneSchema.safeParse(bad).success, false, bad);
  }
});

test("isoDateTimeSchema rejects non-date strings that would throw later", () => {
  assert.equal(isoDateTimeSchema.safeParse("2026-06-18T12:00:00.000Z").success, true);
  assert.equal(isoDateTimeSchema.safeParse("2026-06-18").success, true);
  // Pre-fix these passed `.min(1)` and then threw RangeError at
  // `new Date(value).toISOString()` deeper in the request (500 instead of 400).
  assert.equal(isoDateTimeSchema.safeParse("not-a-date").success, false);
  assert.equal(isoDateTimeSchema.safeParse("tomorrow").success, false);
  assert.equal(isoDateTimeSchema.safeParse("").success, false);
});

test("verifyPassword returns false (never throws) for a malformed stored hash", async () => {
  const good = await hashPassword("correct horse battery staple");

  assert.equal(await verifyPassword("correct horse battery staple", good), true);
  assert.equal(await verifyPassword("wrong", good), false);

  // Malformed hashes: non-numeric scrypt params previously reached scrypt as NaN
  // and threw a RangeError instead of returning false.
  for (const malformed of [
    "scrypt$notnum$8$1$c2FsdA$aGFzaA",
    "scrypt$16384$abc$1$c2FsdA$aGFzaA",
    "scrypt$16384$8$-1$c2FsdA$aGFzaA",
    "scrypt$$$$c2FsdA$aGFzaA",
    "bogus",
  ]) {
    assert.equal(await verifyPassword("whatever", malformed), false, malformed);
  }
});
