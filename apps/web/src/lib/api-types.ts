import type { WatchdogPolicyUpdate } from "@rakkr/shared";

export interface WatchdogCalibrationInput {
  apply?: boolean;
  frameLimit?: number;
  minFrames?: number;
  nodeId: string;
  signalMarginDb?: number;
}

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
