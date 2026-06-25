import type {
  AudioInterface,
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  NodeAudioCommandDefaults,
  RecorderNode,
  RecordingJobChannelMap,
  RecordingProfile,
} from "@rakkr/shared";

import type { SettingsStore } from "./settings-store.js";

interface RecordingJobTargetInput {
  captureBackend?: NodeAudioCommandDefaults["captureBackend"];
  captureInterfaceId?: string;
  durationSeconds?: number;
  node?: RecorderNode;
  profile?: RecordingProfile;
  recordingProfileId?: string;
  settingsStore: SettingsStore;
}

export async function recordingJobTargetOptions({
  captureBackend,
  captureInterfaceId: requestedCaptureInterfaceId,
  durationSeconds,
  node,
  profile: providedProfile,
  recordingProfileId,
  settingsStore,
}: RecordingJobTargetInput) {
  const captureInterfaceId =
    requestedCaptureInterfaceId ??
    process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID ??
    node?.interfaces[0]?.id;
  const captureInterface = node?.interfaces.find(
    (candidate) => candidate.id === captureInterfaceId,
  );
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
    captureBackend:
      captureBackend ??
      knownCaptureBackend(captureInterface) ??
      node?.audioDefaults?.captureBackend,
    captureChannels: node?.audioDefaults?.captureChannels,
    captureDevice: captureDeviceTarget(captureInterface) ?? node?.audioDefaults?.captureDevice,
    captureFormat: node?.audioDefaults?.captureFormat,
    captureInterfaceId,
    captureSampleRate: node?.audioDefaults?.captureSampleRate,
    channelMap,
    durationSeconds,
    profile,
  };
}

function captureDeviceTarget(captureInterface: AudioInterface | undefined) {
  if (!captureInterface) {
    return undefined;
  }

  if (captureInterface.backend !== "alsa") {
    return captureInterface.systemName;
  }

  const systemRef = captureInterface.systemRef?.replace(/^alsa:/, "");

  return systemRef && isAlsaCaptureDeviceRef(systemRef) ? systemRef : captureInterface.systemName;
}

function isAlsaCaptureDeviceRef(value: string) {
  return value.startsWith("hw:") || value.startsWith("plughw:");
}

function knownCaptureBackend(
  captureInterface: AudioInterface | undefined,
): NodeAudioCommandDefaults["captureBackend"] {
  return captureInterface?.backend === "alsa" ||
    captureInterface?.backend === "jack" ||
    captureInterface?.backend === "pipewire"
    ? captureInterface.backend
    : undefined;
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
