import type { RecorderNode } from "@rakkr/shared";

import type { RecordingStartInput } from "@/lib/api";

export interface RecordingStartDraft {
  folder: string;
  name: string;
  nodeId: string;
  recordingProfileId: string;
  tags: string;
  uploadPolicyId: string;
}

export const emptyRecordingStartDraft: RecordingStartDraft = {
  folder: "",
  name: "",
  nodeId: "",
  recordingProfileId: "",
  tags: "ad-hoc, voice",
  uploadPolicyId: "",
};

export function startInputFromDraft(draft: RecordingStartDraft): RecordingStartInput {
  return {
    folder: textOrUndefined(draft.folder),
    name: textOrUndefined(draft.name),
    nodeId: draft.nodeId,
    recordingProfileId: textOrUndefined(draft.recordingProfileId),
    tags: tagsFromText(draft.tags),
    uploadPolicyId: textOrUndefined(draft.uploadPolicyId),
  };
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
