import type { NodeAudioCommandDefaults, NodeRecordingCapacity, NodeRuntime } from "@rakkr/shared";

// Node runtime, recording-capacity, and audio-defaults are stored inside the
// `nodes.metadata` JSON blob. These helpers parse that loosely-typed payload
// back into the strict shared contracts and rebuild the blob on writes.

export function nodeMetadata(
  existingMetadata: unknown,
  runtime: NodeRuntime | undefined,
  recordingCapacity = nodeRecordingCapacityFromMetadata(existingMetadata),
  audioDefaults = nodeAudioDefaultsFromMetadata(existingMetadata),
) {
  const metadata = { ...record(existingMetadata) };

  delete metadata.audioDefaults;
  delete metadata.recordingCapacity;
  delete metadata.runtime;

  return {
    ...metadata,
    ...(audioDefaults ? { audioDefaults } : {}),
    ...(recordingCapacity ? { recordingCapacity } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

export function nodeRuntimeFromInput(runtime: NodeRuntime | undefined, existingMetadata: unknown) {
  return runtime ?? nodeRuntimeFromMetadata(existingMetadata);
}

export function nodeRuntimeFromMetadata(metadata: unknown): NodeRuntime | undefined {
  const runtime = record(metadata)?.runtime;
  const parsed = record(runtime);

  if (!parsed) {
    return undefined;
  }

  return {
    architecture: stringOrUndefined(parsed.architecture),
    audioBackends: audioBackends(parsed.audioBackends),
    kernelRelease: stringOrUndefined(parsed.kernelRelease),
    osName: stringOrUndefined(parsed.osName),
    uptimeSeconds: nonNegativeIntegerOrUndefined(parsed.uptimeSeconds),
  };
}

export function nodeRecordingCapacityFromMetadata(
  metadata: unknown,
): NodeRecordingCapacity | undefined {
  const recordingCapacity = record(record(metadata)?.recordingCapacity);
  const maxConcurrentRecordings = nonNegativeIntegerOrUndefined(
    recordingCapacity?.maxConcurrentRecordings,
  );

  return maxConcurrentRecordings && maxConcurrentRecordings > 0
    ? { maxConcurrentRecordings }
    : undefined;
}

export function nodeAudioDefaultsFromMetadata(
  metadata: unknown,
): NodeAudioCommandDefaults | undefined {
  const parsed = record(record(metadata)?.audioDefaults);

  if (!parsed) {
    return undefined;
  }

  return nonEmptyAudioDefaults({
    captureArgsTemplate: stringOrUndefined(parsed.captureArgsTemplate),
    captureBackend: captureBackendOrUndefined(parsed.captureBackend),
    captureChannels: positiveIntegerOrUndefined(parsed.captureChannels),
    captureCommand: stringOrUndefined(parsed.captureCommand),
    captureDevice: stringOrUndefined(parsed.captureDevice),
    captureFormat: stringOrUndefined(parsed.captureFormat),
    captureSampleRate: positiveIntegerOrUndefined(parsed.captureSampleRate),
    meterArgsTemplate: stringOrUndefined(parsed.meterArgsTemplate),
  });
}

export function nonEmptyAudioDefaults(
  defaults: NodeAudioCommandDefaults,
): NodeAudioCommandDefaults | undefined {
  const entries = Object.entries(defaults).filter(([, value]) => value !== undefined);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function captureBackendOrUndefined(value: unknown) {
  return value === "alsa" || value === "jack" || value === "pipewire" ? value : undefined;
}

function audioBackends(value: unknown): NodeRuntime["audioBackends"] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is NodeRuntime["audioBackends"][number] =>
          item === "alsa" || item === "jack" || item === "pipewire" || item === "unknown",
      )
    : [];
}

export function numberArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function nonNegativeIntegerOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
