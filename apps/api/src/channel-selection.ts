import {
  channelModeMaxChannels,
  channelModeMinChannels,
  type AudioInterface,
  type CaptureChannelSelection,
  type ChannelMapEntry,
  type ChannelMode,
  type RecordingJobChannelMap,
} from "@rakkr/shared";

// Synthetic channel-map identity used when a recording/schedule pins an explicit
// channel selection instead of inheriting an assigned channel-map template. The
// agent treats a pinned `channelMap` as authoritative regardless of these ids.
export const INLINE_CHANNEL_SELECTION_TEMPLATE_ID = "inline-channel-selection";

export type ChannelSelectionError =
  | "channel_selection_empty"
  | "channel_selection_out_of_range"
  | "channel_selection_unknown_channel"
  | "channel_selection_mode_arity";

export type ChannelSelectionValidation =
  | { ok: true }
  | { ok: false; reason: ChannelSelectionError };

// Default output mode for a bare channel selection: a single channel is mono, two
// or more default to stereo (the operator can override per recording/schedule).
export function defaultChannelMode(channelCount: number): ChannelMode {
  return channelCount <= 1 ? "mono" : "stereo";
}

export function resolveChannelMode(
  mode: ChannelMode | null | undefined,
  channelCount: number,
): ChannelMode {
  return mode ?? defaultChannelMode(channelCount);
}

export function validateChannelSelection(
  captureInterface: AudioInterface,
  channels: CaptureChannelSelection,
  mode: ChannelMode,
): ChannelSelectionValidation {
  if (channels.length === 0) {
    return { ok: false, reason: "channel_selection_empty" };
  }

  const known = knownChannelIndices(captureInterface);

  for (const channel of channels) {
    if (channel > captureInterface.channelCount) {
      return { ok: false, reason: "channel_selection_out_of_range" };
    }

    if (known.size > 0 && !known.has(channel)) {
      return { ok: false, reason: "channel_selection_unknown_channel" };
    }
  }

  const min = channelModeMinChannels[mode];
  const max = channelModeMaxChannels[mode];

  if (channels.length < min || (max !== null && channels.length > max)) {
    return { ok: false, reason: "channel_selection_mode_arity" };
  }

  return { ok: true };
}

// Build the job channel map that captures exactly the selected source channels
// and routes them into the chosen output layout. This reuses the agent's
// existing pan-filter render path: `included` source entries select the subset,
// and `outputChannelIndex` drives stereo/multichannel routing (mono modes mix
// every included entry, so output indices are left unset there).
export function channelMapFromSelection(
  captureInterface: AudioInterface,
  channels: CaptureChannelSelection,
  mode: ChannelMode,
): RecordingJobChannelMap {
  const labels = channelLabels(captureInterface);
  const routed = mode === "stereo" || mode === "multichannel";
  const entries: ChannelMapEntry[] = channels.map((sourceChannelIndex, position) => ({
    included: true,
    label: labels.get(sourceChannelIndex) ?? `Channel ${sourceChannelIndex}`,
    outputChannelIndex: routed ? position + 1 : undefined,
    sourceChannelIndex,
  }));

  return {
    assignmentId: INLINE_CHANNEL_SELECTION_TEMPLATE_ID,
    channelMode: mode,
    entries,
    sourceChannels: Math.max(...channels),
    targetId: captureInterface.id,
    targetType: "interface",
    templateId: INLINE_CHANNEL_SELECTION_TEMPLATE_ID,
    templateName: "Channel selection",
  };
}

function knownChannelIndices(captureInterface: AudioInterface): Set<number> {
  if (captureInterface.channels.length > 0) {
    return new Set(captureInterface.channels.map((channel) => channel.index));
  }

  return new Set(Array.from({ length: captureInterface.channelCount }, (_, index) => index + 1));
}

function channelLabels(captureInterface: AudioInterface): Map<number, string> {
  return new Map(captureInterface.channels.map((channel) => [channel.index, channel.alias]));
}
