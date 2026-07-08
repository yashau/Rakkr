import assert from "node:assert/strict";
import test from "node:test";
import type { WatchdogPolicy } from "@rakkr/shared";

import {
  numericInputCommit,
  watchdogPolicyUpdate,
  withWatchdogDisplayDefaults,
} from "./settings-updates";

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
  assert.equal(numericInputCommit(".5"), 0.5);
  assert.equal(numericInputCommit("+3"), 3);
});

test("numericInputCommit rejects non-decimal shapes Number() would otherwise parse", () => {
  // Number("0x1f") === 31, Number("1e3") === 1000, Number("0b101") === 5. None
  // are valid for dBFS/score/second fields; commit nothing rather than a
  // surprising value (audit R7-NUMCOMMIT-HEX).
  assert.equal(numericInputCommit("0x1f"), undefined);
  assert.equal(numericInputCommit("0b101"), undefined);
  assert.equal(numericInputCommit("0o17"), undefined);
  assert.equal(numericInputCommit("1e3"), undefined);
  assert.equal(numericInputCommit("Infinity"), undefined);
  assert.equal(numericInputCommit("12px"), undefined);
});

test("withWatchdogDisplayDefaults fills unset optional fields so the form round-trips", () => {
  // A policy with the optional threshold/mode fields unset. The card renders
  // each with a `?? fallback`; the fold must persist those same values so a save
  // without touching them keeps what the operator saw (audit W4A).
  const sparse: WatchdogPolicy = {
    activeDuring: "scheduled_recording",
    graceSeconds: 0,
    id: "watchdog_sparse",
    metric: "rms",
    minCumulativeSecondsAboveThreshold: 7,
    name: "Sparse",
    repeatEverySeconds: 900,
    severity: "warning",
    thresholdDbfs: -45,
    windowSeconds: 60,
  };

  const folded = withWatchdogDisplayDefaults(sparse);

  assert.equal(folded.channelCorrelationMode, "off");
  assert.equal(folded.clippingMode, "off");
  assert.equal(folded.flatlineMode, "off");
  assert.equal(folded.qualityAlertMode, "off");
  assert.equal(folded.channelCorrelationThreshold, 0.98);
  assert.equal(folded.flatlineThresholdDbfs, -100);
  assert.equal(folded.minCumulativeClippingSeconds, 1);
  assert.equal(folded.minCumulativeFlatlineSeconds, 10);
  assert.equal(folded.broadbandNoiseScoreThreshold, 0.85);
  assert.equal(folded.noiseScoreThreshold, 0.9);
  assert.equal(folded.humScoreThreshold, 0.8);
  assert.equal(folded.staticScoreThreshold, 0.8);
  // The two cumulative-seconds fields fall back to the shared baseline.
  assert.equal(folded.minCumulativeChannelCorrelationSeconds, 7);
  assert.equal(folded.minCumulativeQualitySeconds, 7);
});

test("withWatchdogDisplayDefaults leaves already-set fields untouched", () => {
  const populated = watchdogPolicy();

  assert.deepEqual(withWatchdogDisplayDefaults(populated), populated);
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
