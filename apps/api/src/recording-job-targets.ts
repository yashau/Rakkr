import type {
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  RecorderNode,
  RecordingJobChannelMap,
  RecordingProfile,
} from "@rakkr/shared";

import type { SettingsStore } from "./settings-store.js";

interface RecordingJobTargetInput {
  durationSeconds?: number;
  node?: RecorderNode;
  profile?: RecordingProfile;
  recordingProfileId?: string;
  settingsStore: SettingsStore;
}

export async function recordingJobTargetOptions({
  durationSeconds,
  node,
  profile: providedProfile,
  recordingProfileId,
  settingsStore,
}: RecordingJobTargetInput) {
  const captureInterfaceId =
    process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID ?? node?.interfaces[0]?.id;
  const profile =
    providedProfile ??
    (recordingProfileId ? await settingsStore.findRecordingProfile(recordingProfileId) : undefined);
  const channelMap = node
    ? await activeChannelMapSelection({
        captureInterfaceId,
        nodeId: node.id,
        settingsStore,
      })
    : undefined;

  return {
    captureChannels: node?.audioDefaults?.captureChannels,
    captureDevice: node?.audioDefaults?.captureDevice,
    captureFormat: node?.audioDefaults?.captureFormat,
    captureInterfaceId,
    captureSampleRate: node?.audioDefaults?.captureSampleRate,
    channelMap,
    durationSeconds,
    profile,
  };
}

async function activeChannelMapSelection({
  captureInterfaceId,
  nodeId,
  settingsStore,
}: {
  captureInterfaceId?: string;
  nodeId: string;
  settingsStore: SettingsStore;
}): Promise<RecordingJobChannelMap | undefined> {
  const assignments = await settingsStore.listChannelMapAssignments();
  const assignment =
    assignments.find(
      (candidate) =>
        candidate.targetType === "interface" && candidate.targetId === captureInterfaceId,
    ) ??
    assignments.find(
      (candidate) => candidate.targetType === "node" && candidate.targetId === nodeId,
    );

  if (!assignment) {
    return undefined;
  }

  const template = await settingsStore.findChannelMapTemplate(assignment.templateId);

  return template ? channelMapSelection(assignment, template) : undefined;
}

function channelMapSelection(
  assignment: ChannelMapTemplateAssignment,
  template: ChannelMapTemplate,
): RecordingJobChannelMap | undefined {
  const sourceChannels = Math.max(
    ...template.entries.filter((entry) => entry.included).map((entry) => entry.sourceChannelIndex),
  );

  if (!Number.isFinite(sourceChannels) || sourceChannels <= 0) {
    return undefined;
  }

  return {
    assignmentId: assignment.id,
    channelMode: template.channelMode,
    entries: template.entries,
    sourceChannels,
    targetId: assignment.targetId,
    targetType: assignment.targetType,
    templateId: template.id,
    templateName: template.name,
  };
}
