import type { HealthEvent } from "@rakkr/shared";

export function qualityEventEvidenceText(event: HealthEvent) {
  if (event.type === "controller.recording.upload_queue_failed") {
    return uploadFailureEvidenceText(event.details);
  }

  if (event.type === "watchdog.clipping") {
    return clippingEvidenceText(event.details);
  }

  if (event.type === "watchdog.channel_correlation") {
    return channelCorrelationEvidenceText(event.details);
  }

  if (event.details.speechBelowThreshold === true) {
    return speechEvidenceText(event.details);
  }

  return signalEvidenceText(event.details);
}

function uploadFailureEvidenceText(details: Record<string, unknown>) {
  const provider = stringDetail(details.provider);
  const reason = stringDetail(details.reason);
  const parts = [
    provider ? `upload ${provider}` : "upload failed",
    reason ? reason.replaceAll("_", " ") : undefined,
  ].filter(Boolean);

  return parts.join(" / ");
}

function clippingEvidenceText(details: Record<string, unknown>) {
  const seconds = numberDetail(details.cumulativeClippingSeconds);
  const channels = numberArrayDetail(details.latestClippingChannelIndexes);
  const parts = [
    seconds === undefined ? undefined : `clip ${formatSeconds(seconds)}`,
    channels.length ? `channels ${channels.join(", ")}` : undefined,
  ].filter(Boolean);

  return parts.join(" / ") || undefined;
}

function channelCorrelationEvidenceText(details: Record<string, unknown>) {
  const score = numberDetail(details.maxChannelCorrelationScore);
  const seconds = numberDetail(details.cumulativeCorrelatedSeconds);
  const parts = [
    score === undefined ? undefined : `corr ${score.toFixed(2)}`,
    seconds === undefined ? undefined : formatSeconds(seconds),
  ].filter(Boolean);

  return parts.join(" / ") || undefined;
}

function speechEvidenceText(details: Record<string, unknown>) {
  const speechSeconds = numberDetail(details.cumulativeSpeechLikeSeconds);
  const requiredSeconds = numberDetail(details.minCumulativeSpeechSeconds);
  const speechScore = numberDetail(details.maxSpeechScore);
  const parts = [
    speechScore === undefined ? undefined : `speech ${Math.round(speechScore * 100)}%`,
    speechSeconds === undefined ? undefined : formatSeconds(speechSeconds),
    requiredSeconds === undefined ? undefined : `min ${formatSeconds(requiredSeconds)}`,
  ].filter(Boolean);

  return parts.join(" / ") || undefined;
}

function signalEvidenceText(details: Record<string, unknown>) {
  const maxMetric = numberDetail(details.maxMetricDbfs);
  const threshold = numberDetail(details.thresholdDbfs);

  if (maxMetric === undefined) {
    return undefined;
  }

  return `max ${maxMetric.toFixed(1)} dBFS${
    threshold === undefined ? "" : ` / min ${threshold.toFixed(1)}`
  }`;
}

function formatSeconds(value: number) {
  return `${Number(value.toFixed(1))}s`;
}

function numberDetail(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArrayDetail(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];
}

function stringDetail(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
