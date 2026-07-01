import assert from "node:assert/strict";
import test from "node:test";
import { defaultScheduledVoiceWatchdogPolicy, watchdogPolicySchema } from "@rakkr/shared";

test("R13-5: watchdog policy duration fields are bounded on create like on update", () => {
  // The shipped default (all durations well under the 24h ceiling) still passes.
  assert.equal(watchdogPolicySchema.safeParse(defaultScheduledVoiceWatchdogPolicy).success, true);

  // Every duration field the update schema caps at 86_400s is now rejected by
  // the base (create) schema too — pre-fix these were unbounded on create, so a
  // policy could be created that could never be updated, and huge windows left
  // recordings effectively unmonitored.
  const cappedDurationFields = [
    "graceSeconds",
    "minCumulativeChannelCorrelationSeconds",
    "minCumulativeClippingSeconds",
    "minCumulativeFlatlineSeconds",
    "minCumulativeQualitySeconds",
    "minCumulativeSecondsAboveThreshold",
    "minCumulativeSpeechSeconds",
    "repeatEverySeconds",
    "windowSeconds",
  ] as const;

  for (const field of cappedDurationFields) {
    const result = watchdogPolicySchema.safeParse({
      ...defaultScheduledVoiceWatchdogPolicy,
      [field]: 100_000,
    });

    assert.equal(result.success, false, `${field} above 86_400 must be rejected`);
  }
});
