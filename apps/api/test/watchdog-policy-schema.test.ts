import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultScheduledVoiceWatchdogPolicy,
  watchdogPolicySchema,
  watchdogPolicyUpdateSchema,
} from "@rakkr/shared";

test("watchdog policy schema stays permissive on read but bounds durations on input", () => {
  // watchdogPolicySchema also parses persisted rows (watchdogPolicyFromRow), so
  // it must accept any previously-stored value — a `.max` here would 503 the
  // policy list on a single legacy over-cap row. The 86_400s ceiling belongs on
  // the input (update) schema instead.
  assert.equal(watchdogPolicySchema.safeParse(defaultScheduledVoiceWatchdogPolicy).success, true);
  assert.equal(
    watchdogPolicySchema.safeParse({
      ...defaultScheduledVoiceWatchdogPolicy,
      windowSeconds: 100_000,
    }).success,
    true,
    "the data schema must load legacy over-cap rows, not reject them",
  );

  // The input path (update) enforces the 24h ceiling.
  assert.equal(watchdogPolicyUpdateSchema.safeParse({ windowSeconds: 100_000 }).success, false);
  assert.equal(watchdogPolicyUpdateSchema.safeParse({ windowSeconds: 900 }).success, true);
});
