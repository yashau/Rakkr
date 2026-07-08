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
  if (raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

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
