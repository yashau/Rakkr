import type { MeterFrame, WatchdogPolicy } from "@rakkr/shared";

export interface SignalHistory {
  lastSampleAtMs?: number;
  samples: SignalSample[];
}

interface ChannelCorrelationPair {
  leftChannelIndex: number;
  phase: "inverted" | "same";
  rightChannelIndex: number;
  score: number;
}

interface SignalSample {
  capturedAtMs: number;
  channelCorrelationPairs: ChannelCorrelationPair[];
  channelIndex?: number;
  clippingChannelIndexes: number[];
  durationSeconds: number;
  flatline: boolean;
  highBroadbandNoise: boolean;
  highHum: boolean;
  highNoise: boolean;
  highStatic: boolean;
  interfaceId?: string;
  maxChannelCorrelationScore: number;
  maxBroadbandNoiseScore: number;
  maxHumScore: number;
  maxNoiseScore: number;
  maxPeakDbfs: number;
  maxRmsDbfs: number;
  maxSpeechScore: number;
  maxStaticScore: number;
  metricDbfs: number;
  speechLike: boolean;
}

export interface SignalEvaluation {
  coverageSeconds: number;
  cumulativeCorrelatedSeconds: number;
  cumulativeHighBroadbandNoiseSeconds: number;
  cumulativeClippingSeconds: number;
  cumulativeFlatlineSeconds: number;
  cumulativeHighHumSeconds: number;
  cumulativeHighNoiseSeconds: number;
  cumulativeHighStaticSeconds: number;
  cumulativeSecondsAboveThreshold: number;
  cumulativeSpeechLikeSeconds: number;
  latestChannelCorrelationPairs: ChannelCorrelationPair[];
  latestChannelIndex?: number;
  latestClippingChannelIndexes: number[];
  latestFlatline: boolean;
  latestBroadbandNoiseScore: number;
  latestHumScore: number;
  latestInterfaceId?: string;
  latestMetricDbfs: number;
  latestNoiseScore: number;
  latestPeakDbfs: number;
  latestRmsDbfs: number;
  latestSpeechScore: number;
  latestStaticScore: number;
  maxChannelCorrelationScore: number;
  maxBroadbandNoiseScore: number;
  maxClippingChannelCount: number;
  maxHumScore: number;
  maxMetricDbfs: number;
  maxNoiseScore: number;
  maxSpeechScore: number;
  maxStaticScore: number;
  sampleCount: number;
  windowStartedAt: string;
}

export function historyFor(histories: Map<string, SignalHistory>, recordingId: string) {
  const existing = histories.get(recordingId);

  if (existing) {
    return existing;
  }

  const history: SignalHistory = { samples: [] };

  histories.set(recordingId, history);

  return history;
}

export function pruneHistory(history: SignalHistory, policy: WatchdogPolicy, now: Date) {
  const oldestSampleAt = now.getTime() - policy.windowSeconds * 1_000;

  history.samples = history.samples.filter((sample) => sample.capturedAtMs >= oldestSampleAt);
}

export function pruneInactiveHistories(
  histories: Map<string, SignalHistory>,
  activeRecordingIds: Set<string>,
) {
  for (const recordingId of histories.keys()) {
    if (!activeRecordingIds.has(recordingId)) {
      histories.delete(recordingId);
    }
  }
}

export function signalSample(
  frame: MeterFrame | undefined,
  policy: WatchdogPolicy,
  lastSampleAtMs: number | undefined,
  now: Date,
): SignalSample {
  const durationSeconds = lastSampleAtMs
    ? Math.min(Math.max((now.getTime() - lastSampleAtMs) / 1_000, 0), maxSampleSpanSeconds())
    : 0;

  if (!frame || frame.levels.length === 0) {
    return {
      capturedAtMs: now.getTime(),
      channelCorrelationPairs: [],
      clippingChannelIndexes: [],
      durationSeconds,
      flatline: true,
      highBroadbandNoise: false,
      highHum: false,
      highNoise: false,
      highStatic: false,
      maxChannelCorrelationScore: 0,
      maxBroadbandNoiseScore: 0,
      maxHumScore: 0,
      maxNoiseScore: 0,
      maxPeakDbfs: -160,
      maxRmsDbfs: -160,
      maxSpeechScore: 0,
      maxStaticScore: 0,
      metricDbfs: -160,
      speechLike: false,
    };
  }

  const channelCorrelationPairs = strongestCorrelationPairs(frame);
  const clippingChannelIndexes = frame.levels
    .filter((level) => level.clipping)
    .map((level) => level.channelIndex)
    .sort((left, right) => left - right);
  const maxChannelCorrelationScore = Math.max(
    0,
    ...channelCorrelationPairs.map((pair) => Math.abs(pair.score)),
  );
  const maxBroadbandNoiseScore = Math.max(
    0,
    ...frame.levels.map((level) => level.quality?.broadbandNoiseScore ?? 0),
  );
  const maxHumScore = Math.max(0, ...frame.levels.map((level) => level.quality?.humScore ?? 0));
  const maxPeak = Math.max(...frame.levels.map((level) => level.peakDbfs));
  const maxRms = Math.max(...frame.levels.map((level) => level.rmsDbfs));
  const maxNoiseScore = Math.max(0, ...frame.levels.map((level) => level.quality?.noiseScore ?? 0));
  const maxSpeechScore = Math.max(
    0,
    ...frame.levels.map((level) => level.quality?.speechScore ?? 0),
  );
  const maxStaticScore = Math.max(
    0,
    ...frame.levels.map((level) => level.quality?.staticScore ?? 0),
  );
  const metricLevel =
    policy.metric === "peak"
      ? maxBy(frame.levels, (level) => level.peakDbfs)
      : maxBy(frame.levels, (level) => level.rmsDbfs);

  return {
    capturedAtMs: now.getTime(),
    channelCorrelationPairs,
    channelIndex: metricLevel.channelIndex,
    clippingChannelIndexes,
    durationSeconds,
    flatline: maxRms <= flatlineThresholdDbfs(policy),
    highBroadbandNoise: maxBroadbandNoiseScore >= broadbandNoiseScoreThreshold(policy),
    highHum: maxHumScore >= humScoreThreshold(policy),
    highNoise: maxNoiseScore >= noiseScoreThreshold(policy),
    highStatic: maxStaticScore >= staticScoreThreshold(policy),
    interfaceId: frame.interfaceId,
    maxChannelCorrelationScore: Number(maxChannelCorrelationScore.toFixed(2)),
    maxBroadbandNoiseScore: Number(maxBroadbandNoiseScore.toFixed(2)),
    maxHumScore: Number(maxHumScore.toFixed(2)),
    maxNoiseScore: Number(maxNoiseScore.toFixed(2)),
    maxPeakDbfs: Number(maxPeak.toFixed(1)),
    maxRmsDbfs: Number(maxRms.toFixed(1)),
    maxSpeechScore: Number(maxSpeechScore.toFixed(2)),
    maxStaticScore: Number(maxStaticScore.toFixed(2)),
    metricDbfs: Number(metricValue(frame, policy).toFixed(1)),
    speechLike: maxSpeechScore >= minSpeechScore(policy),
  };
}

export function signalEvaluation(
  history: SignalHistory,
  policy: WatchdogPolicy,
  now: Date,
): SignalEvaluation {
  const windowStartMs = now.getTime() - policy.windowSeconds * 1_000;
  const samples = history.samples.filter((sample) => sample.capturedAtMs >= windowStartMs);
  const latest = samples.at(-1);
  const maxMetricDbfs = samples.length
    ? Math.max(...samples.map((sample) => sample.metricDbfs))
    : -160;
  const coverageSeconds = samples.reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeSecondsAboveThreshold = samples
    .filter((sample) => sample.metricDbfs >= policy.thresholdDbfs)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeSpeechLikeSeconds = samples
    .filter((sample) => sample.speechLike)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeCorrelatedSeconds = samples
    .filter((sample) => sample.maxChannelCorrelationScore >= channelCorrelationThreshold(policy))
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeClippingSeconds = samples
    .filter((sample) => sample.clippingChannelIndexes.length > 0)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeHighBroadbandNoiseSeconds = samples
    .filter((sample) => sample.highBroadbandNoise)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeFlatlineSeconds = samples
    .filter((sample) => sample.flatline)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeHighHumSeconds = samples
    .filter((sample) => sample.highHum)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeHighNoiseSeconds = samples
    .filter((sample) => sample.highNoise)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const cumulativeHighStaticSeconds = samples
    .filter((sample) => sample.highStatic)
    .reduce((total, sample) => total + sample.durationSeconds, 0);
  const maxChannelCorrelationScore = samples.length
    ? Math.max(...samples.map((sample) => sample.maxChannelCorrelationScore))
    : 0;
  const maxBroadbandNoiseScore = samples.length
    ? Math.max(...samples.map((sample) => sample.maxBroadbandNoiseScore))
    : 0;
  const maxClippingChannelCount = samples.length
    ? Math.max(...samples.map((sample) => sample.clippingChannelIndexes.length))
    : 0;
  const maxHumScore = samples.length ? Math.max(...samples.map((sample) => sample.maxHumScore)) : 0;
  const maxNoiseScore = samples.length
    ? Math.max(...samples.map((sample) => sample.maxNoiseScore))
    : 0;
  const maxSpeechScore = samples.length
    ? Math.max(...samples.map((sample) => sample.maxSpeechScore))
    : 0;
  const maxStaticScore = samples.length
    ? Math.max(...samples.map((sample) => sample.maxStaticScore))
    : 0;

  return {
    coverageSeconds,
    cumulativeCorrelatedSeconds,
    cumulativeHighBroadbandNoiseSeconds,
    cumulativeClippingSeconds,
    cumulativeFlatlineSeconds,
    cumulativeHighHumSeconds,
    cumulativeHighNoiseSeconds,
    cumulativeHighStaticSeconds,
    cumulativeSecondsAboveThreshold,
    cumulativeSpeechLikeSeconds,
    latestChannelCorrelationPairs: latest?.channelCorrelationPairs ?? [],
    latestChannelIndex: latest?.channelIndex,
    latestClippingChannelIndexes: latest?.clippingChannelIndexes ?? [],
    latestFlatline: latest?.flatline ?? false,
    latestBroadbandNoiseScore: latest?.maxBroadbandNoiseScore ?? 0,
    latestHumScore: latest?.maxHumScore ?? 0,
    latestInterfaceId: latest?.interfaceId,
    latestMetricDbfs: latest?.metricDbfs ?? -160,
    latestNoiseScore: latest?.maxNoiseScore ?? 0,
    latestPeakDbfs: latest?.maxPeakDbfs ?? -160,
    latestRmsDbfs: latest?.maxRmsDbfs ?? -160,
    latestSpeechScore: latest?.maxSpeechScore ?? 0,
    latestStaticScore: latest?.maxStaticScore ?? 0,
    maxChannelCorrelationScore: Number(maxChannelCorrelationScore.toFixed(2)),
    maxBroadbandNoiseScore: Number(maxBroadbandNoiseScore.toFixed(2)),
    maxClippingChannelCount,
    maxHumScore: Number(maxHumScore.toFixed(2)),
    maxMetricDbfs: Number(maxMetricDbfs.toFixed(1)),
    maxNoiseScore: Number(maxNoiseScore.toFixed(2)),
    maxSpeechScore: Number(maxSpeechScore.toFixed(2)),
    maxStaticScore: Number(maxStaticScore.toFixed(2)),
    sampleCount: samples.length,
    windowStartedAt: new Date(windowStartMs).toISOString(),
  };
}

export function signalIsBelowPolicy(evaluation: SignalEvaluation, policy: WatchdogPolicy) {
  return signalLevelIsBelowPolicy(evaluation, policy) || speechIsBelowPolicy(evaluation, policy);
}

export function signalLevelIsBelowPolicy(evaluation: SignalEvaluation, policy: WatchdogPolicy) {
  if (evaluation.maxMetricDbfs < policy.thresholdDbfs) {
    return true;
  }

  if (evaluation.coverageSeconds < policy.minCumulativeSecondsAboveThreshold) {
    return false;
  }

  return evaluation.cumulativeSecondsAboveThreshold < policy.minCumulativeSecondsAboveThreshold;
}

export function speechIsBelowPolicy(evaluation: SignalEvaluation, policy: WatchdogPolicy) {
  if (policy.qualityMode !== "speech_required") {
    return false;
  }

  const requiredSpeechSeconds = minCumulativeSpeechSeconds(policy);

  if (evaluation.coverageSeconds < requiredSpeechSeconds) {
    return false;
  }

  return evaluation.cumulativeSpeechLikeSeconds < requiredSpeechSeconds;
}

export function channelCorrelationIsAbovePolicy(
  evaluation: SignalEvaluation,
  policy: WatchdogPolicy,
) {
  if (policy.channelCorrelationMode !== "alert_on_high") {
    return false;
  }

  const requiredSeconds = minCumulativeChannelCorrelationSeconds(policy);

  if (evaluation.coverageSeconds < requiredSeconds) {
    return false;
  }

  return evaluation.cumulativeCorrelatedSeconds >= requiredSeconds;
}

export function clippingIsAbovePolicy(evaluation: SignalEvaluation, policy: WatchdogPolicy) {
  if (policy.clippingMode !== "alert_on_clipping") {
    return false;
  }

  const requiredSeconds = minCumulativeClippingSeconds(policy);

  if (requiredSeconds <= 0) {
    return evaluation.cumulativeClippingSeconds > 0;
  }

  if (evaluation.coverageSeconds < requiredSeconds) {
    return false;
  }

  return evaluation.cumulativeClippingSeconds >= requiredSeconds;
}

export function flatlineIsAbovePolicy(evaluation: SignalEvaluation, policy: WatchdogPolicy) {
  if (policy.flatlineMode !== "alert_on_flatline") {
    return false;
  }

  const requiredSeconds = minCumulativeFlatlineSeconds(policy);

  if (requiredSeconds <= 0) {
    return evaluation.cumulativeFlatlineSeconds > 0;
  }

  if (evaluation.coverageSeconds < requiredSeconds) {
    return false;
  }

  return evaluation.cumulativeFlatlineSeconds >= requiredSeconds;
}

export function qualityAnomalyIsAbovePolicy(evaluation: SignalEvaluation, policy: WatchdogPolicy) {
  if (policy.qualityAlertMode !== "alert_on_noise_hum_static") {
    return false;
  }

  const requiredSeconds = minCumulativeQualitySeconds(policy);

  if (requiredSeconds <= 0) {
    return (
      evaluation.cumulativeHighNoiseSeconds > 0 ||
      evaluation.cumulativeHighBroadbandNoiseSeconds > 0 ||
      evaluation.cumulativeHighHumSeconds > 0 ||
      evaluation.cumulativeHighStaticSeconds > 0
    );
  }

  if (evaluation.coverageSeconds < requiredSeconds) {
    return false;
  }

  return (
    evaluation.cumulativeHighNoiseSeconds >= requiredSeconds ||
    evaluation.cumulativeHighBroadbandNoiseSeconds >= requiredSeconds ||
    evaluation.cumulativeHighHumSeconds >= requiredSeconds ||
    evaluation.cumulativeHighStaticSeconds >= requiredSeconds
  );
}

export function channelCorrelationThreshold(policy: WatchdogPolicy) {
  return policy.channelCorrelationThreshold ?? 0.98;
}

export function broadbandNoiseScoreThreshold(policy: WatchdogPolicy) {
  return policy.broadbandNoiseScoreThreshold ?? 0.85;
}

export function flatlineThresholdDbfs(policy: WatchdogPolicy) {
  return policy.flatlineThresholdDbfs ?? -100;
}

export function humScoreThreshold(policy: WatchdogPolicy) {
  return policy.humScoreThreshold ?? 0.8;
}

export function minCumulativeChannelCorrelationSeconds(policy: WatchdogPolicy) {
  return policy.minCumulativeChannelCorrelationSeconds ?? policy.minCumulativeSecondsAboveThreshold;
}

export function minCumulativeClippingSeconds(policy: WatchdogPolicy) {
  return policy.minCumulativeClippingSeconds ?? 1;
}

export function minCumulativeFlatlineSeconds(policy: WatchdogPolicy) {
  return policy.minCumulativeFlatlineSeconds ?? policy.minCumulativeSecondsAboveThreshold;
}

export function minCumulativeQualitySeconds(policy: WatchdogPolicy) {
  return policy.minCumulativeQualitySeconds ?? policy.minCumulativeSecondsAboveThreshold;
}

export function minCumulativeSpeechSeconds(policy: WatchdogPolicy) {
  return policy.minCumulativeSpeechSeconds ?? policy.minCumulativeSecondsAboveThreshold;
}

export function minSpeechScore(policy: WatchdogPolicy) {
  return policy.minSpeechScore ?? 0.55;
}

export function noiseScoreThreshold(policy: WatchdogPolicy) {
  return policy.noiseScoreThreshold ?? 0.9;
}

export function staticScoreThreshold(policy: WatchdogPolicy) {
  return policy.staticScoreThreshold ?? 0.8;
}

function strongestCorrelationPairs(frame: MeterFrame): ChannelCorrelationPair[] {
  const pairs = new Map<string, ChannelCorrelationPair>();

  for (const level of frame.levels) {
    const correlation = level.quality?.channelCorrelation;

    if (!correlation) {
      continue;
    }

    const leftChannelIndex = Math.min(level.channelIndex, correlation.peerChannelIndex);
    const rightChannelIndex = Math.max(level.channelIndex, correlation.peerChannelIndex);
    const key = `${leftChannelIndex}:${rightChannelIndex}`;
    const existing = pairs.get(key);

    if (!existing || Math.abs(correlation.score) > Math.abs(existing.score)) {
      pairs.set(key, {
        leftChannelIndex,
        phase: correlation.phase,
        rightChannelIndex,
        score: correlation.score,
      });
    }
  }

  return Array.from(pairs.values()).sort(
    (left, right) =>
      left.leftChannelIndex - right.leftChannelIndex ||
      left.rightChannelIndex - right.rightChannelIndex,
  );
}

function metricValue(frame: MeterFrame, policy: WatchdogPolicy) {
  if (policy.metric === "peak") {
    return Math.max(...frame.levels.map((level) => level.peakDbfs));
  }

  if (policy.metric === "percentile_95") {
    return percentile(
      frame.levels.map((level) => level.rmsDbfs),
      0.95,
    );
  }

  return Math.max(...frame.levels.map((level) => level.rmsDbfs));
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return -160;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);

  return sorted[index] ?? -160;
}

function maxBy<T>(values: T[], selector: (value: T) => number) {
  return values.reduce((winner, value) => (selector(value) > selector(winner) ? value : winner));
}

function maxSampleSpanSeconds() {
  return positiveInteger(process.env.RAKKR_WATCHDOG_MAX_SAMPLE_SPAN_SECONDS, 30);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
