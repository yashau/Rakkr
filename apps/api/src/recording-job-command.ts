import { recordingEnhancementSchema, type RecordingJob } from "@rakkr/shared";

// Deserialization of a persisted recording-job command (the Postgres JSONB
// `command` column or the JSON-store blob) back into a typed
// RecordingJobCommand. Extracted from recording-jobs.ts to keep that module
// under the 1000-LOC budget; the parsing is intentionally tolerant so a legacy
// or partially-populated row still yields a usable command.
type RecordingJobCommand = RecordingJob["command"];

export function commandFromValue(value: unknown): RecordingJobCommand {
  if (!isRecord(value) || value.type !== "alsa_capture") {
    throw new Error("recording_job_command_invalid");
  }

  return {
    captureChannels: positiveIntegerFromUnknown(value.captureChannels, 2),
    captureBackend: captureBackendFromUnknown(value.captureBackend),
    captureChannelSelection: channelSelectionFromUnknown(value.captureChannelSelection),
    captureDevice: stringFromUnknown(value.captureDevice, "default"),
    captureFormat: stringFromUnknown(value.captureFormat, "S16_LE"),
    captureGroupId: stringOrUndefined(value.captureGroupId),
    captureInterfaceId: stringOrUndefined(value.captureInterfaceId),
    captureSampleRate: positiveIntegerFromUnknown(value.captureSampleRate, 48_000),
    channelMap: channelMapFromValue(value.channelMap),
    chunkSeconds: optionalPositiveInteger(value.chunkSeconds),
    durationSeconds: positiveIntegerFromUnknown(value.durationSeconds, 3_600),
    enhancement: enhancementFromValue(value.enhancement),
    outputBitrateKbps: optionalPositiveInteger(value.outputBitrateKbps),
    outputCodec: outputCodecFromUnknown(value.outputCodec),
    outputFileName: stringFromUnknown(value.outputFileName, "recording.wav"),
    outputVbr: typeof value.outputVbr === "boolean" ? value.outputVbr : undefined,
    recorderCacheRetention: recorderCacheRetentionFromValue(value.recorderCacheRetention),
    trackGroupId: stringOrUndefined(value.trackGroupId),
    trackIndex: optionalPositiveInteger(value.trackIndex),
    trackTotal: optionalPositiveInteger(value.trackTotal),
    type: "alsa_capture",
  };
}

function positiveIntegerFromUnknown(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function channelSelectionFromUnknown(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const channels = value.filter(
    (channel): channel is number =>
      typeof channel === "number" && Number.isInteger(channel) && channel > 0,
  );

  return channels.length > 0 ? channels : undefined;
}

function stringFromUnknown(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function channelMapFromValue(value: unknown): RecordingJobCommand["channelMap"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceChannels = positiveIntegerFromUnknown(value.sourceChannels, 0);

  if (sourceChannels <= 0) {
    return undefined;
  }

  return {
    assignmentId: stringFromUnknown(value.assignmentId, "unknown_assignment"),
    channelMode: channelModeFromUnknown(value.channelMode),
    entries: channelMapEntriesFromValue(value.entries, sourceChannels),
    sourceChannels,
    targetId: stringFromUnknown(value.targetId, "unknown_target"),
    targetType: value.targetType === "interface" ? "interface" : "node",
    templateId: stringFromUnknown(value.templateId, "unknown_template"),
    templateName: stringFromUnknown(value.templateName, "Unknown Template"),
  };
}

function channelMapEntriesFromValue(value: unknown, sourceChannels: number) {
  if (!Array.isArray(value)) {
    return Array.from({ length: sourceChannels }, (_, index) => ({
      included: true,
      label: `Channel ${index + 1}`,
      outputChannelIndex: index + 1,
      sourceChannelIndex: index + 1,
    }));
  }

  return value.filter(isRecord).map((entry) => ({
    included: entry.included === true,
    label: stringFromUnknown(
      entry.label,
      `Channel ${positiveIntegerFromUnknown(entry.sourceChannelIndex, 1)}`,
    ),
    outputChannelIndex:
      typeof entry.outputChannelIndex === "number" && Number.isInteger(entry.outputChannelIndex)
        ? entry.outputChannelIndex
        : undefined,
    sourceChannelIndex: positiveIntegerFromUnknown(entry.sourceChannelIndex, 1),
  }));
}

function channelModeFromUnknown(
  value: unknown,
): NonNullable<RecordingJobCommand["channelMap"]>["channelMode"] {
  return value === "mono" ||
    value === "stereo" ||
    value === "mono_to_stereo_mix" ||
    value === "multichannel"
    ? value
    : "mono_to_stereo_mix";
}

function outputCodecFromUnknown(value: unknown): RecordingJobCommand["outputCodec"] {
  return value === "mp3" || value === "flac" || value === "wav" ? value : undefined;
}

function enhancementFromValue(value: unknown): RecordingJobCommand["enhancement"] {
  if (value === undefined || value === null) {
    return undefined;
  }

  const result = recordingEnhancementSchema.safeParse(value);

  return result.success ? result.data : undefined;
}

function recorderCacheRetentionFromValue(
  value: unknown,
): RecordingJobCommand["recorderCacheRetention"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const policyId = stringOrUndefined(value.policyId);

  if (!policyId || typeof value.deleteAfterUpload !== "boolean") {
    return undefined;
  }

  return {
    deleteAfterUpload: value.deleteAfterUpload,
    policyId,
  };
}

function captureBackendFromUnknown(value: unknown): RecordingJobCommand["captureBackend"] {
  return value === "pipewire"
    ? "pipewire"
    : value === "jack"
      ? "jack"
      : value === "alsa"
        ? "alsa"
        : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
