import type { ChannelMode, RecordingJob, WatchdogPolicyUpdate } from "@rakkr/shared";

export interface RecordingStartInput {
  captureBackend?: NonNullable<RecordingJob["command"]["captureBackend"]>;
  captureChannelSelection?: number[];
  captureInterfaceId?: string;
  channelMode?: ChannelMode;
  folder?: string;
  name?: string;
  nodeId: string;
  recordingProfileId?: string;
  tags?: string[];
  uploadPolicyIds?: string[];
}

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
