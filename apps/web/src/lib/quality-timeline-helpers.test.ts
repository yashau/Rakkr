import assert from "node:assert/strict";
import test from "node:test";
import type { HealthEvent } from "@rakkr/shared";

import { qualityEventEvidenceText } from "./quality-timeline-helpers";

test("quality timeline evidence describes clipping channels and duration", () => {
  assert.equal(
    qualityEventEvidenceText(
      event("watchdog.clipping", {
        cumulativeClippingSeconds: 30,
        latestClippingChannelIndexes: [1, 2],
      }),
    ),
    "clip 30s / channels 1, 2",
  );
});

test("quality timeline evidence describes flatline duration", () => {
  assert.equal(
    qualityEventEvidenceText(
      event("watchdog.flatline", {
        cumulativeFlatlineSeconds: 30,
        flatlineThresholdDbfs: -80,
        latestRmsDbfs: -92,
      }),
    ),
    "flatline 30s / rms -92.0 dBFS / max -80.0",
  );
});

test("quality timeline evidence describes quality anomaly scores", () => {
  assert.equal(
    qualityEventEvidenceText(
      event("watchdog.quality_anomaly", {
        cumulativeHighBroadbandNoiseSeconds: 24,
        cumulativeHighHumSeconds: 12,
        cumulativeHighNoiseSeconds: 30,
        cumulativeHighStaticSeconds: 6,
        maxBroadbandNoiseScore: 0.87,
        maxHumScore: 0.82,
        maxNoiseScore: 0.91,
        maxStaticScore: 0.86,
      }),
    ),
    "broadband 87% / noise 91% / hum 82% / static 86% / 30s",
  );
});

test("quality timeline evidence describes channel correlation strength", () => {
  assert.equal(
    qualityEventEvidenceText(
      event("watchdog.channel_correlation", {
        cumulativeCorrelatedSeconds: 12.5,
        maxChannelCorrelationScore: 0.987,
      }),
    ),
    "corr 0.99 / 12.5s",
  );
});

test("quality timeline evidence describes speech-required failures", () => {
  assert.equal(
    qualityEventEvidenceText(
      event("watchdog.scheduled_low_signal", {
        cumulativeSpeechLikeSeconds: 4,
        maxSpeechScore: 0.21,
        minCumulativeSpeechSeconds: 20,
        speechBelowThreshold: true,
      }),
    ),
    "speech 21% / 4s / min 20s",
  );
});

test("quality timeline evidence falls back to dBFS signal detail", () => {
  assert.equal(
    qualityEventEvidenceText(
      event("watchdog.scheduled_low_signal", {
        maxMetricDbfs: -52.4,
        thresholdDbfs: -45,
      }),
    ),
    "max -52.4 dBFS / min -45.0",
  );
});

test("quality timeline evidence describes upload queue failures", () => {
  assert.equal(
    qualityEventEvidenceText(
      event("controller.recording.upload_queue_failed", {
        provider: "smb",
        reason: "cache_path_missing",
        source: "upload_runner",
      }),
    ),
    "upload smb / cache path missing",
  );
});

function event(type: string, details: Record<string, unknown>): HealthEvent {
  return {
    acknowledgedAt: null,
    details,
    id: `health_${type}`,
    openedAt: "2026-06-20T06:00:00.000Z",
    resolvedAt: null,
    severity: "warning",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type,
  };
}
