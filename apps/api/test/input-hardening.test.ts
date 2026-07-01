import assert from "node:assert/strict";
import test from "node:test";
import { isoDateTimeSchema } from "@rakkr/shared";
import { hashPassword, verifyPassword } from "../src/password.js";

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
