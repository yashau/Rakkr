import type { AudioLevel } from "@rakkr/shared";

const meterFloorDbfs = -72;
const meterCeilingDbfs = -3;

export interface MeterChannelView {
  clipping: boolean;
  correlationLabel?: string;
  correlationPercent?: number;
  humPercent?: number;
  intelligibilityPercent?: number;
  noisePercent?: number;
  peakDbfs: string;
  peakPercent: number;
  rmsDbfs: string;
  rmsPercent: number;
  snrDb?: string;
  speechLabel: "speech" | "non-speech" | "unknown";
  speechPercent?: number;
  staticPercent?: number;
  toneClass: string;
}

export interface MeterBankSummary {
  clippingChannels: number;
  maxPeakDbfs: string;
  maxRmsDbfs: string;
  speechChannels: number;
}

export const meterScaleLabels = ["-72", "-54", "-36", "-18", "-6", "0"];

export function dbfsToPercent(dbfs: number) {
  return clampPercent(((dbfs - meterFloorDbfs) / (meterCeilingDbfs - meterFloorDbfs)) * 100);
}

export function meterChannelView(level: AudioLevel): MeterChannelView {
  const speechScore = level.quality?.speechScore;
  const noiseScore = level.quality?.noiseScore;
  const correlation = level.quality?.channelCorrelation;

  return {
    clipping: level.clipping,
    correlationLabel: correlation
      ? `ch ${correlation.peerChannelIndex} ${correlation.phase}`
      : undefined,
    correlationPercent: scoreToPercent(correlation ? Math.abs(correlation.score) : undefined),
    humPercent: scoreToPercent(level.quality?.humScore),
    intelligibilityPercent: scoreToPercent(level.quality?.intelligibilityScore),
    noisePercent: scoreToPercent(noiseScore),
    peakDbfs: formatDbfs(level.peakDbfs),
    peakPercent: dbfsToPercent(level.peakDbfs),
    rmsDbfs: formatDbfs(level.rmsDbfs),
    rmsPercent: dbfsToPercent(level.rmsDbfs),
    snrDb: formatOptionalDb(level.quality?.estimatedSnrDb),
    speechLabel:
      level.quality === undefined ? "unknown" : level.quality.speechLike ? "speech" : "non-speech",
    speechPercent: scoreToPercent(speechScore),
    staticPercent: scoreToPercent(level.quality?.staticScore),
    toneClass: meterToneClass(level),
  };
}

export function meterBankSummary(levels: AudioLevel[]): MeterBankSummary {
  const maxPeak = maxLevel(levels, "peakDbfs");
  const maxRms = maxLevel(levels, "rmsDbfs");

  return {
    clippingChannels: levels.filter((level) => level.clipping).length,
    maxPeakDbfs: maxPeak === undefined ? "n/a" : formatDbfs(maxPeak),
    maxRmsDbfs: maxRms === undefined ? "n/a" : formatDbfs(maxRms),
    speechChannels: levels.filter((level) => level.quality?.speechLike).length,
  };
}

export function meterToneClass(level: AudioLevel) {
  if (level.clipping || level.peakDbfs > -3) {
    return "from-amber-400 via-orange-500 to-red-500";
  }

  if (level.peakDbfs > -12) {
    return "from-emerald-500 via-lime-400 to-amber-400";
  }

  if (level.peakDbfs > -36) {
    return "from-sky-500 via-emerald-400 to-lime-300";
  }

  return "from-cyan-500 via-sky-400 to-emerald-300";
}

function maxLevel(levels: AudioLevel[], key: "peakDbfs" | "rmsDbfs") {
  if (levels.length === 0) {
    return undefined;
  }

  return Math.max(...levels.map((level) => level[key]));
}

function formatDbfs(value: number) {
  return `${value.toFixed(1)} dBFS`;
}

function formatOptionalDb(value: number | undefined) {
  return value === undefined ? undefined : `${value.toFixed(1)} dB`;
}

function scoreToPercent(score: number | undefined) {
  return score === undefined ? undefined : Math.round(clampPercent(score * 100));
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}
