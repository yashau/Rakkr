import type { ChannelMode, RecorderNode } from "@rakkr/shared";

import type { RecordingStartInput } from "@/lib/api-types";

export interface RecordingStartDraft {
  captureBackend: "" | NonNullable<RecordingStartInput["captureBackend"]>;
  captureChannels: number[];
  captureInterfaceId: string;
  channelMode: "" | ChannelMode;
  folder: string;
  name: string;
  nodeId: string;
  recordingProfileId: string;
  tags: string;
  uploadPolicyIds: string[];
}

export const emptyRecordingStartDraft: RecordingStartDraft = {
  captureBackend: "",
  captureChannels: [],
  captureInterfaceId: "",
  channelMode: "",
  folder: "",
  name: "",
  nodeId: "",
  recordingProfileId: "",
  tags: "ad-hoc, voice",
  uploadPolicyIds: [],
};

export function startInputFromDraft(draft: RecordingStartDraft): RecordingStartInput {
  // Channel selection only applies when a specific interface is pinned; an empty
  // selection records the whole interface (legacy behavior).
  const channels = draft.captureInterfaceId ? sortedChannels(draft.captureChannels) : [];

  return {
    captureBackend: draft.captureBackend || undefined,
    captureChannelSelection: channels.length > 0 ? channels : undefined,
    captureInterfaceId: textOrUndefined(draft.captureInterfaceId),
    channelMode: channels.length > 0 && draft.channelMode ? draft.channelMode : undefined,
    folder: textOrUndefined(draft.folder),
    name: textOrUndefined(draft.name),
    nodeId: draft.nodeId,
    recordingProfileId: textOrUndefined(draft.recordingProfileId),
    tags: tagsFromText(draft.tags),
    uploadPolicyIds: draft.uploadPolicyIds.length > 0 ? draft.uploadPolicyIds : undefined,
  };
}

export function sortedChannels(channels: number[]): number[] {
  return [...new Set(channels)].sort((left, right) => left - right);
}

export function recordingStartNodeLabel(
  node: Pick<RecorderNode, "alias" | "ipAddresses" | "location" | "status">,
) {
  const location = [
    node.location.site,
    node.location.building,
    node.location.floor,
    node.location.room,
  ]
    .filter(Boolean)
    .join(" / ");
  const details = [location, node.status, node.ipAddresses[0]].filter(Boolean).join(" · ");

  return details ? `${node.alias} (${details})` : node.alias;
}

export function tagsFromText(value: string) {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const tag of value.split(",")) {
    const trimmed = tag.trim();
    const key = trimmed.toLocaleLowerCase();

    if (trimmed && !seen.has(key)) {
      seen.add(key);
      tags.push(trimmed);
    }
  }

  return tags;
}

function textOrUndefined(value: string) {
  const trimmed = value.trim();

  return trimmed || undefined;
}
