import type {
  RecordingProfile,
  RecordingProfileUpdate,
  WatchdogPolicy,
  WatchdogPolicyUpdate,
} from "@rakkr/shared";

// The value a numeric <input> change should COMMIT to a draft, or `undefined` to
// leave the committed value unchanged. Returning undefined for an empty/invalid
// field is what stops `Number("") === 0` from silently committing a 0 — e.g. a
// watchdog `thresholdDbfs`/score threshold cleared to `0` passes server
// validation and arms an always-fire alert (audit H4-2). Callers keep a local
// text buffer so the field stays clearable while typing.
export function numericInputCommit(raw: string): number | undefined {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return undefined;
  }

  // Only accept a plain decimal shape (optional sign, digits, optional
  // fraction). `Number()` also parses hex/octal/binary ("0x1f") and exponent
  // forms, none of which are valid for these operational fields (dBFS, 0–1
  // scores, seconds) and would silently commit a surprising value
  // (audit R7-NUMCOMMIT-HEX).
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : undefined;
}

export function recordingProfileUpdate(profile: RecordingProfile): RecordingProfileUpdate {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    chunkSeconds: profile.chunkSeconds ?? null,
    codec: profile.codec,
    enhancement: profile.enhancement,
    maxTrackSeconds: profile.maxTrackSeconds ?? null,
    name: profile.name,
    silenceDetectionEnabled: profile.silenceDetectionEnabled,
    silenceSkipEnabled: profile.silenceSkipEnabled,
    vbr: profile.vbr,
  };
}

// Normalize a watchdog policy into a fully-populated editor draft: fill every
// optional field the card renders with a `?? fallback` so the value shown in the
// form is exactly what a save persists. Without this, a policy with an unset
// optional field showed the fallback (e.g. a 0.98 correlation threshold) but
// saved it as unset — the displayed value silently did not round-trip
// (audit W4A-WATCHDOG-DISPLAY-DEFAULT). Modes fold to "off" (disabled), numeric
// thresholds to their built-in fallback, and the two cumulative-seconds fields
// to the shared `minCumulativeSecondsAboveThreshold` baseline.
export function withWatchdogDisplayDefaults(policy: WatchdogPolicy): WatchdogPolicy {
  return {
    ...policy,
    broadbandNoiseScoreThreshold: policy.broadbandNoiseScoreThreshold ?? 0.85,
    channelCorrelationMode: policy.channelCorrelationMode ?? "off",
    channelCorrelationThreshold: policy.channelCorrelationThreshold ?? 0.98,
    clippingMode: policy.clippingMode ?? "off",
    flatlineMode: policy.flatlineMode ?? "off",
    flatlineThresholdDbfs: policy.flatlineThresholdDbfs ?? -100,
    humScoreThreshold: policy.humScoreThreshold ?? 0.8,
    minCumulativeChannelCorrelationSeconds:
      policy.minCumulativeChannelCorrelationSeconds ?? policy.minCumulativeSecondsAboveThreshold,
    minCumulativeClippingSeconds: policy.minCumulativeClippingSeconds ?? 1,
    minCumulativeFlatlineSeconds: policy.minCumulativeFlatlineSeconds ?? 10,
    minCumulativeQualitySeconds:
      policy.minCumulativeQualitySeconds ?? policy.minCumulativeSecondsAboveThreshold,
    noiseScoreThreshold: policy.noiseScoreThreshold ?? 0.9,
    qualityAlertMode: policy.qualityAlertMode ?? "off",
    staticScoreThreshold: policy.staticScoreThreshold ?? 0.8,
  };
}

export function watchdogPolicyUpdate(policy: WatchdogPolicy): WatchdogPolicyUpdate {
  return {
    activeDuring: policy.activeDuring,
    broadbandNoiseScoreThreshold: policy.broadbandNoiseScoreThreshold,
    channelCorrelationMode: policy.channelCorrelationMode,
    channelCorrelationThreshold: policy.channelCorrelationThreshold,
    clippingMode: policy.clippingMode,
    flatlineMode: policy.flatlineMode,
    flatlineThresholdDbfs: policy.flatlineThresholdDbfs,
    graceSeconds: policy.graceSeconds,
    humScoreThreshold: policy.humScoreThreshold,
    metric: policy.metric,
    minCumulativeChannelCorrelationSeconds: policy.minCumulativeChannelCorrelationSeconds,
    minCumulativeClippingSeconds: policy.minCumulativeClippingSeconds,
    minCumulativeFlatlineSeconds: policy.minCumulativeFlatlineSeconds,
    minCumulativeQualitySeconds: policy.minCumulativeQualitySeconds,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    minCumulativeSpeechSeconds: policy.minCumulativeSpeechSeconds,
    minSpeechScore: policy.minSpeechScore,
    name: policy.name,
    noiseScoreThreshold: policy.noiseScoreThreshold,
    qualityAlertMode: policy.qualityAlertMode,
    qualityMode: policy.qualityMode,
    repeatEverySeconds: policy.repeatEverySeconds,
    severity: policy.severity,
    staticScoreThreshold: policy.staticScoreThreshold,
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
  };
}

export function optionalPositiveNumber(value: string) {
  const trimmed = value.trim();
  const parsed = Number(trimmed);

  return trimmed && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
