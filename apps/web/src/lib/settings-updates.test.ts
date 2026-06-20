import assert from "node:assert/strict";
import test from "node:test";
import type { WatchdogPolicy } from "@rakkr/shared";

import { watchdogPolicyUpdate } from "./settings-updates";

test("watchdog policy update preserves quality and flatline fields", () => {
  assert.deepEqual(watchdogPolicyUpdate(watchdogPolicy()), {
    activeDuring: "scheduled_recording",
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
