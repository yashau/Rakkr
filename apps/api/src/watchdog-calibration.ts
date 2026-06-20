import { z } from "zod";
import type { MeterFrame, WatchdogPolicy, WatchdogPolicyUpdate } from "@rakkr/shared";

export const watchdogCalibrationInputSchema = z.object({
  apply: z.boolean().default(false),
  frameLimit: z.number().int().min(3).max(600).default(120),
  minFrames: z.number().int().min(3).max(600).default(5),
  nodeId: z.string().trim().min(1).max(160),
  signalMarginDb: z.number().min(0).max(40).default(8),
});

export type WatchdogCalibrationInput = z.infer<typeof watchdogCalibrationInputSchema>;

export interface WatchdogCalibrationResult {
  analysis: {
    frameCount: number;
    maxNoiseScore: number;
    medianMetricDbfs: number;
    medianSpeechScore: number;
    observedMaxMetricDbfs: number;
    observedP95MetricDbfs: number;
    speechLikeFrameCount: number;
  };
  applied: boolean;
  recommendation: {
    marginDb: number;
    update: WatchdogPolicyUpdate;
  };
  warnings: string[];
}

export function calibrateWatchdogPolicy(
  policy: WatchdogPolicy,
  frames: MeterFrame[],
  input: WatchdogCalibrationInput,
): WatchdogCalibrationResult {
  if (frames.length < input.minFrames) {
    throw new WatchdogCalibrationError("insufficient_meter_history");
  }

  const frameSummaries = frames.map((frame) => summarizeFrame(frame, policy));
  const metricValues = frameSummaries.map((frame) => frame.metricDbfs);
  const speechScores = frameSummaries.map((frame) => frame.speechScore);
  const noiseScores = frameSummaries.map((frame) => frame.noiseScore);
  const observedP95MetricDbfs = roundDbfs(percentile(metricValues, 0.95));
  const thresholdDbfs = clampDbfs(roundDbfs(observedP95MetricDbfs - input.signalMarginDb));
  const update: WatchdogPolicyUpdate = { thresholdDbfs };
  const warnings: string[] = [];

  if (policy.qualityMode === "speech_required") {
    const speechLikeScores = speechScores.filter((score) => score >= 0.35);

    if (speechLikeScores.length === 0) {
      warnings.push("no_speech_like_frames");
    } else {
      update.minSpeechScore = clampScore(roundScore(percentile(speechLikeScores, 0.25) - 0.1));
    }
  }

  if (noiseScores.every((score) => score === 0) && speechScores.every((score) => score === 0)) {
    warnings.push("quality_scores_missing");
  }

  return {
    analysis: {
      frameCount: frames.length,
      maxNoiseScore: roundScore(Math.max(...noiseScores)),
      medianMetricDbfs: roundDbfs(percentile(metricValues, 0.5)),
      medianSpeechScore: roundScore(percentile(speechScores, 0.5)),
      observedMaxMetricDbfs: roundDbfs(Math.max(...metricValues)),
      observedP95MetricDbfs,
      speechLikeFrameCount: frameSummaries.filter((frame) => frame.speechLike).length,
    },
    applied: input.apply,
    recommendation: {
      marginDb: input.signalMarginDb,
      update,
    },
    warnings,
  };
}

export class WatchdogCalibrationError extends Error {
  constructor(readonly code: "insufficient_meter_history") {
    super(code);
  }
}

function summarizeFrame(frame: MeterFrame, policy: WatchdogPolicy) {
  const levels = frame.levels;

  if (levels.length === 0) {
    return {
      metricDbfs: -160,
      noiseScore: 0,
      speechLike: false,
      speechScore: 0,
    };
  }

  const speechScore = Math.max(0, ...levels.map((level) => level.quality?.speechScore ?? 0));

  return {
    metricDbfs: metricValue(frame, policy),
    noiseScore: Math.max(0, ...levels.map((level) => level.quality?.noiseScore ?? 0)),
    speechLike: levels.some((level) => level.quality?.speechLike),
    speechScore,
  };
}

function metricValue(frame: MeterFrame, policy: WatchdogPolicy) {
  if (policy.metric === "peak") {
    return Math.max(...frame.levels.map((level) => level.peakDbfs));
  }

  const rmsValues = frame.levels.map((level) => level.rmsDbfs);

  return policy.metric === "percentile_95" ? percentile(rmsValues, 0.95) : Math.max(...rmsValues);
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return -160;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);

  return sorted[index] ?? -160;
}

function clampDbfs(value: number) {
  return Math.max(-160, Math.min(24, value));
}

function clampScore(value: number) {
  return Math.max(0, Math.min(1, value));
}

function roundDbfs(value: number) {
  return Number(value.toFixed(1));
}

function roundScore(value: number) {
  return Number(value.toFixed(2));
}
