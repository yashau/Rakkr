import assert from "node:assert/strict";
import test from "node:test";
import type { WatchdogPolicy } from "@rakkr/shared";

import { numericInputCommit, watchdogPolicyUpdate } from "./settings-updates";

test("numericInputCommit never coerces an empty/invalid numeric field to 0", () => {
  // The bug: a cleared watchdog threshold field yields Number("") === 0, which
  // the server accepts (dbfsSchema allows 0, score thresholds allow 0) and arms
  // an always-fire alert. An empty/invalid entry must NOT commit a value.
  assert.equal(numericInputCommit(""), undefined);
  assert.equal(numericInputCommit("   "), undefined);
  assert.equal(numericInputCommit("abc"), undefined);
  // A deliberately-typed number (including 0) still commits.
  assert.equal(numericInputCommit("0"), 0);
  assert.equal(numericInputCommit("-18.5"), -18.5);
  assert.equal(numericInputCommit("0.97"), 0.97);
  assert.equal(numericInputCommit("120"), 120);
});

test("watchdog policy update preserves quality and flatline fields", () => {
  assert.deepEqual(watchdogPolicyUpdate(watchdogPolicy()), {
    activeDuring: "scheduled_recording",
    broadbandNoiseScoreThreshold: 0.84,
    channelCorrelationMode: "alert_on_high",
    channelCorrelationThreshold: 0.97,
    clippingMode: "alert_on_clipping",
    flatlineMode: "alert_on_flatline",
    flatlineThresholdDbfs: -105,
    graceSeconds: 30,
    humScoreThreshold: 0.76,
    metric: "rms",
    minCumulativeChannelCorrelationSeconds: 15,
    minCumulativeClippingSeconds: 2,
    minCumulativeFlatlineSeconds: 12,
    minCumulativeQualitySeconds: 18,
    minCumulativeSecondsAboveThreshold: 10,
    minCumulativeSpeechSeconds: 20,
    minSpeechScore: 0.65,
    name: "Council Watchdog",
    noiseScoreThreshold: 0.88,
    qualityAlertMode: "alert_on_noise_hum_static",
    qualityMode: "speech_required",
    repeatEverySeconds: 900,
    severity: "critical",
    staticScoreThreshold: 0.79,
    thresholdDbfs: -45,
    windowSeconds: 60,
  });
});

function watchdogPolicy(): WatchdogPolicy {
  return {
    activeDuring: "scheduled_recording",
    broadbandNoiseScoreThreshold: 0.84,
    channelCorrelationMode: "alert_on_high",
    channelCorrelationThreshold: 0.97,
    clippingMode: "alert_on_clipping",
    flatlineMode: "alert_on_flatline",
    flatlineThresholdDbfs: -105,
    graceSeconds: 30,
    humScoreThreshold: 0.76,
    id: "watchdog_council",
    metric: "rms",
    minCumulativeChannelCorrelationSeconds: 15,
    minCumulativeClippingSeconds: 2,
    minCumulativeFlatlineSeconds: 12,
    minCumulativeQualitySeconds: 18,
    minCumulativeSecondsAboveThreshold: 10,
    minCumulativeSpeechSeconds: 20,
    minSpeechScore: 0.65,
    name: "Council Watchdog",
    noiseScoreThreshold: 0.88,
    qualityAlertMode: "alert_on_noise_hum_static",
    qualityMode: "speech_required",
    repeatEverySeconds: 900,
    severity: "critical",
    staticScoreThreshold: 0.79,
    thresholdDbfs: -45,
    windowSeconds: 60,
  };
}
