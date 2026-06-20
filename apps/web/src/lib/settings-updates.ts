import type {
  RecordingProfile,
  RecordingProfileUpdate,
  UploadProviderConfigUpdate,
  UploadProviderRuntimeStatus,
  WatchdogPolicy,
  WatchdogPolicyUpdate,
} from "@rakkr/shared";

export function recordingProfileUpdate(profile: RecordingProfile): RecordingProfileUpdate {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    codec: profile.codec,
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
    channelCorrelationMode: policy.channelCorrelationMode,
    channelCorrelationThreshold: policy.channelCorrelationThreshold,
    clippingMode: policy.clippingMode,
    flatlineMode: policy.flatlineMode,
    flatlineThresholdDbfs: policy.flatlineThresholdDbfs,
    graceSeconds: policy.graceSeconds,
    metric: policy.metric,
    minCumulativeChannelCorrelationSeconds: policy.minCumulativeChannelCorrelationSeconds,
    minCumulativeClippingSeconds: policy.minCumulativeClippingSeconds,
    minCumulativeFlatlineSeconds: policy.minCumulativeFlatlineSeconds,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    minCumulativeSpeechSeconds: policy.minCumulativeSpeechSeconds,
    minSpeechScore: policy.minSpeechScore,
    name: policy.name,
    qualityMode: policy.qualityMode,
    repeatEverySeconds: policy.repeatEverySeconds,
    severity: policy.severity,
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
  };
}

export function uploadProviderUpdate(
  provider: UploadProviderRuntimeStatus,
): UploadProviderConfigUpdate {
  return {
    credentialRef: optionalText(provider.credentialRef),
    displayName: provider.displayName,
    enabled: provider.enabled,
    target: optionalText(provider.target),
  };
}

export function optionalPositiveNumber(value: string) {
  const trimmed = value.trim();
  const parsed = Number(trimmed);

  return trimmed && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalText(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed || undefined;
}
