import { randomUUID } from "node:crypto";
import type {
  ChannelMode,
  RecorderNode,
  ScheduleInput,
  ScheduleRecurrence,
  ScheduleSummary,
  ScheduleUpdate,
} from "@rakkr/shared";

import { resolveChannelMode, validateChannelSelection } from "./channel-selection.js";
import {
  effectiveCaptureInterfaceId,
  resolveSelectionRoom,
  type SelectionRoomResolution,
} from "./room-resolution.js";
import { nextRunAtForRecurrence, uniqueTags } from "./schedule-engine.js";

export function captureBackendFromQuery(value: string | undefined) {
  return value === "alsa" || value === "jack" || value === "pipewire" ? value : undefined;
}

export function enabledFromQuery(value: string | undefined) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

export function trimmed(value: string | undefined) {
  const next = value?.trim();

  return next || undefined;
}

export function buildSchedule(input: ScheduleInput): ScheduleSummary {
  const recurrence = input.recurrence ?? recurrenceFromNextRun(input.nextRunAt);

  return {
    assignedGroupIds: input.assignedGroupIds,
    assignedUserIds: input.assignedUserIds,
    roomId: input.roomId,
    captureBackend: input.captureBackend ?? undefined,
    captureChannelSelection: input.captureChannelSelection ?? undefined,
    captureInterfaceId: input.captureInterfaceId ?? undefined,
    channelMode: input.channelMode ?? undefined,
    enabled: input.enabled,
    folderTemplate: input.folderTemplate,
    id: input.id ?? `sched_${randomUUID()}`,
    name: input.name,
    nextRunAt: nextRunAtForRecurrence(recurrence, input.timezone, input.nextRunAt),
    nodeId: input.nodeId,
    recurrence,
    recordingProfileId: input.recordingProfileId,
    retentionPolicyId: input.retentionPolicyId,
    room: input.room,
    tags: uniqueTags(input.tags),
    timezone: input.timezone,
    titleTemplate: input.titleTemplate,
    uploadPolicyIds: input.uploadPolicyIds,
    watchdogPolicyId: input.watchdogPolicyId,
  };
}

export function sanitizeScheduleUpdate(
  input: ScheduleUpdate,
  before: ScheduleSummary,
): Partial<Omit<ScheduleSummary, "id">> {
  const { captureBackend, captureChannelSelection, captureInterfaceId, channelMode, ...rest } =
    input;
  const updates: Partial<Omit<ScheduleSummary, "id">> = { ...rest };

  if ("captureBackend" in input) {
    updates.captureBackend = captureBackend ?? undefined;
  }

  if ("captureChannelSelection" in input) {
    updates.captureChannelSelection = captureChannelSelection ?? undefined;
  }

  if ("captureInterfaceId" in input) {
    updates.captureInterfaceId = captureInterfaceId ?? undefined;
  }

  if ("channelMode" in input) {
    updates.channelMode = channelMode ?? undefined;
  }

  if (input.recurrence || input.timezone) {
    updates.nextRunAt = nextRunAtForRecurrence(
      input.recurrence ?? before.recurrence,
      input.timezone ?? before.timezone,
      input.nextRunAt,
    );
  } else if (input.nextRunAt) {
    updates.nextRunAt = validIsoOrUndefined(input.nextRunAt);
  }

  if (input.tags) {
    updates.tags = uniqueTags(input.tags);
  }

  return updates;
}

export function isValidScheduleTiming(input: {
  nextRunAt?: string;
  recurrence?: ScheduleRecurrence;
}) {
  const nextRunAt = input.recurrence?.mode === "once" ? input.recurrence.startsAt : input.nextRunAt;

  return isValidOptionalDate(nextRunAt);
}

function isValidOptionalDate(value: string | undefined) {
  return !value || !Number.isNaN(Date.parse(value));
}

function validIsoOrUndefined(value: string | undefined) {
  return value ? new Date(value).toISOString() : undefined;
}

export function scheduleInterfaceIsValid(
  node: RecorderNode,
  captureInterfaceId: string | null | undefined,
) {
  return (
    !captureInterfaceId || node.interfaces.some((candidate) => candidate.id === captureInterfaceId)
  );
}

// Validates a schedule's channel selection against the (possibly node-default)
// capture interface. Returns the failure reason, or undefined when the schedule
// pins no channel selection or the selection is valid.
export function scheduleChannelSelectionFailure(
  node: RecorderNode,
  captureInterfaceId: string | null | undefined,
  selection: number[] | null | undefined,
  mode: ChannelMode | null | undefined,
): string | undefined {
  if (!selection || selection.length === 0) {
    return undefined;
  }

  const interfaceId = captureInterfaceId ?? node.interfaces[0]?.id;
  const captureInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);

  if (!captureInterface) {
    return "schedule_interface_not_found";
  }

  const validation = validateChannelSelection(
    captureInterface,
    selection,
    resolveChannelMode(mode, selection.length),
  );

  return validation.ok ? undefined : validation.reason;
}

// Resolves the single room a schedule captures from its selected channels (or the
// whole capture interface). A schedule is one room only; returns ok:false when the
// selection spans rooms so the caller can reject it. The capture interface is
// resolved via effectiveCaptureInterfaceId — the SAME precedence the recorder
// runtime uses (explicit id, then the RAKKR_AGENT_CAPTURE_INTERFACE_ID env
// default, then the node's first interface) — so the attributed room matches the
// interface actually captured.
export function resolveScheduleRoom(
  node: RecorderNode,
  captureInterfaceId: string | null | undefined,
  selection: number[] | null | undefined,
): SelectionRoomResolution {
  const interfaceId = effectiveCaptureInterfaceId(node, captureInterfaceId);

  if (!interfaceId) {
    return { ok: true, roomId: node.roomId };
  }

  return resolveSelectionRoom(
    node,
    interfaceId,
    selection && selection.length > 0 ? selection : "all",
  );
}

export function occurrenceLimit(value: string | undefined) {
  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : 5;
}

function recurrenceFromNextRun(nextRunAt: string | undefined): ScheduleRecurrence {
  return nextRunAt
    ? { mode: "once", startsAt: new Date(nextRunAt).toISOString() }
    : { mode: "manual" };
}
