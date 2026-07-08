import {
  defaultKeepControllerCacheRetentionPolicy,
  defaultScheduledVoiceWatchdogPolicy,
  defaultStubUploadPolicy,
  defaultVoiceRecordingProfile,
  type AuditEvent,
  type ChannelMode,
  type ControllerSettings,
  type RecorderNode,
  type ScheduleDayOfWeek,
  type ScheduleInput,
  type ScheduleOccurrencePreview,
  type ScheduleRecurrence,
  type ScheduleSummary,
} from "@rakkr/shared";

import { formatDateTime, isoFromLocalDateTime, localDateTimeInput } from "./dates";

export interface ScheduleDraft {
  assignedGroupIds: string[];
  assignedUserIds: string[];
  captureBackend: "" | NonNullable<ScheduleSummary["captureBackend"]>;
  captureChannels: number[];
  captureInterfaceId: string;
  channelMode: "" | ChannelMode;
  dayOfMonth: number;
  daysOfWeek: ScheduleDayOfWeek[];
  enabled: boolean;
  endTime: string;
  exceptions: NonNullable<ScheduleRecurrence["exceptions"]>;
  folderTemplate: string;
  interval: number;
  name: string;
  nextRunAt: string;
  nodeId: string;
  pauseEndDate: string;
  pauseReason: string;
  pauseStartDate: string;
  recurrenceMode: ScheduleRecurrence["mode"];
  recurrenceStartAt: string;
  recordingProfileId: string;
  retentionPolicyId: string;
  room: string;
  startTime: string;
  startEarlyMinutes: number;
  stopLateMinutes: number;
  tags: string;
  timezone: string;
  titleTemplate: string;
  uploadPolicyIds: string[];
  watchdogPolicyId: string;
}

export const fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const dayOptions: Array<{ id: ScheduleDayOfWeek; label: string }> = [
  { id: "monday", label: "Mon" },
  { id: "tuesday", label: "Tue" },
  { id: "wednesday", label: "Wed" },
  { id: "thursday", label: "Thu" },
  { id: "friday", label: "Fri" },
  { id: "saturday", label: "Sat" },
  { id: "sunday", label: "Sun" },
];
const weekdayDays: ScheduleDayOfWeek[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];

// Operator-configured scheduling defaults (from controller settings) win; when
// unset each profile/policy falls back to its built-in. Upload has no built-in
// fallback — an unset upload default means "no upload" (recording stays in the
// controller cache), so the test-only stub never seeds a real schedule.
export function defaultDraft(node?: RecorderNode, defaults?: ControllerSettings): ScheduleDraft {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    captureBackend: "",
    captureChannels: [],
    captureInterfaceId: "",
    channelMode: "",
    dayOfMonth: 1,
    daysOfWeek: ["monday"],
    enabled: true,
    endTime: "10:00",
    exceptions: [],
    folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
    interval: 1,
    name: "",
    nextRunAt: "",
    nodeId: node?.id ?? "",
    pauseEndDate: "",
    pauseReason: "",
    pauseStartDate: "",
    recurrenceMode: "once",
    recurrenceStartAt: "",
    recordingProfileId: defaults?.defaultRecordingProfileId ?? defaultVoiceRecordingProfile.id,
    retentionPolicyId:
      defaults?.defaultRetentionPolicyId ?? defaultKeepControllerCacheRetentionPolicy.id,
    room: node?.location.room ?? "",
    startTime: "09:00",
    startEarlyMinutes: 0,
    stopLateMinutes: 0,
    tags: "voice, scheduled",
    timezone: fallbackTimezone,
    titleTemplate: "{{date}}_{{time}}_{{schedule.name}}_{{node.alias}}",
    uploadPolicyIds: defaults?.defaultUploadPolicyId ? [defaults.defaultUploadPolicyId] : [],
    watchdogPolicyId: defaults?.defaultWatchdogPolicyId ?? defaultScheduledVoiceWatchdogPolicy.id,
  };
}

export function scheduleToDraft(schedule: ScheduleSummary): ScheduleDraft {
  const draft: ScheduleDraft = {
    ...defaultDraft(),
    assignedGroupIds: schedule.assignedGroupIds,
    assignedUserIds: schedule.assignedUserIds,
    captureBackend: schedule.captureBackend ?? "",
    captureChannels: schedule.captureChannelSelection ?? [],
    captureInterfaceId: schedule.captureInterfaceId ?? "",
    channelMode: schedule.channelMode ?? "",
    enabled: schedule.enabled,
    folderTemplate: schedule.folderTemplate,
    name: schedule.name,
    nextRunAt: localDateTimeInput(schedule.nextRunAt),
    nodeId: schedule.nodeId,
    recordingProfileId: schedule.recordingProfileId,
    retentionPolicyId: schedule.retentionPolicyId,
    room: schedule.room,
    tags: schedule.tags.join(", "),
    timezone: schedule.timezone,
    titleTemplate: schedule.titleTemplate,
    // Drop the test-only stub from a legacy schedule persisted with it: the form's
    // policy toggles filter the stub out, so a retained stub id would be invisible
    // yet silently re-saved on every edit (audit H3-2). Loading it out resolves the
    // schedule to "no upload", matching the stub-removal intent.
    uploadPolicyIds: schedule.uploadPolicyIds.filter((id) => id !== defaultStubUploadPolicy.id),
    watchdogPolicyId: schedule.watchdogPolicyId,
  };

  return applyRecurrenceToDraft(draft, schedule.recurrence);
}

export function draftToInput(draft: ScheduleDraft): ScheduleInput {
  const recurrence = recurrenceFromDraft(draft);
  // Channel selection only applies when a specific interface is pinned.
  const channels = draft.captureInterfaceId
    ? [...new Set(draft.captureChannels)].sort((left, right) => left - right)
    : [];

  return {
    assignedGroupIds: draft.assignedGroupIds,
    assignedUserIds: draft.assignedUserIds,
    captureBackend: draft.captureBackend || null,
    captureChannelSelection: channels.length > 0 ? channels : null,
    captureInterfaceId: draft.captureInterfaceId || null,
    channelMode: channels.length > 0 && draft.channelMode ? draft.channelMode : null,
    enabled: draft.enabled,
    folderTemplate: draft.folderTemplate,
    name: draft.name,
    nextRunAt: nextRunAtFromDraft(draft, recurrence),
    nodeId: draft.nodeId,
    recurrence,
    recordingProfileId: draft.recordingProfileId,
    retentionPolicyId: draft.retentionPolicyId,
    room: draft.room,
    tags: uniqueTags(draft.tags),
    timezone: draft.timezone,
    titleTemplate: draft.titleTemplate,
    uploadPolicyIds: draft.uploadPolicyIds,
    watchdogPolicyId: draft.watchdogPolicyId,
  };
}

export function recurrenceSummary(recurrence: ScheduleRecurrence) {
  if (recurrence.mode === "manual") {
    return "Manual next run";
  }

  if (recurrence.mode === "once") {
    return `One-off at ${formatDateTime(recurrence.startsAt)}`;
  }

  if (recurrence.mode === "daily") {
    return `Every ${intervalLabel(recurrence.interval, "day")} ${recurrence.startTime}-${recurrence.endTime}`;
  }

  if (recurrence.mode === "weekly") {
    return `Every ${intervalLabel(recurrence.interval, "week")} on ${dayList(recurrence.daysOfWeek)} ${recurrence.startTime}-${recurrence.endTime}`;
  }

  if (recurrence.mode === "monthly") {
    return `Every ${intervalLabel(recurrence.interval, "month")} on day ${recurrence.dayOfMonth} ${recurrence.startTime}-${recurrence.endTime}`;
  }

  return "Always on";
}

export function bufferSummary(recurrence: ScheduleRecurrence) {
  const startEarly = secondsToMinutes(recurrence.startEarlySeconds);
  const stopLate = secondsToMinutes(recurrence.stopLateSeconds);

  if (startEarly === 0 && stopLate === 0) {
    return "None";
  }

  return `Start ${startEarly}m early / stop ${stopLate}m late`;
}

export function exceptionSummary(recurrence: ScheduleRecurrence) {
  const exceptions = recurrence.exceptions ?? [];

  return exceptions.length > 0 ? exceptions.map(exceptionLabel).join(", ") : "None";
}

export function occurrenceWindow(occurrence: ScheduleOccurrencePreview) {
  const scheduledStart = occurrence.scheduledStartAt
    ? `scheduled ${formatDateTime(occurrence.scheduledStartAt)}`
    : "manual start";
  const recordingEnd = occurrence.recordingEndAt
    ? `, records until ${formatDateTime(occurrence.recordingEndAt)}`
    : "";

  return `${scheduledStart}${recordingEnd}`;
}

export function scheduleTimelineEvents(scheduleId: string, events: AuditEvent[]) {
  return events
    .filter(
      (event) => event.target.id === scheduleId || event.correlationIds?.scheduleId === scheduleId,
    )
    .slice(0, 4);
}

export function timelineAction(event: AuditEvent) {
  return event.action.replace(/^schedules\./, "").replaceAll("_", " ");
}

export function addPauseRangeToDraft(draft: ScheduleDraft) {
  if (!draft.pauseStartDate || !draft.pauseEndDate) {
    return draft;
  }

  const startDate =
    draft.pauseStartDate <= draft.pauseEndDate ? draft.pauseStartDate : draft.pauseEndDate;
  const endDate =
    draft.pauseStartDate <= draft.pauseEndDate ? draft.pauseEndDate : draft.pauseStartDate;

  return {
    ...draft,
    exceptions: [
      ...draft.exceptions,
      {
        action: "pause" as const,
        endDate,
        ...(draft.pauseReason.trim() ? { reason: draft.pauseReason.trim() } : {}),
        startDate,
      },
    ].sort(compareExceptions),
    pauseEndDate: "",
    pauseReason: "",
    pauseStartDate: "",
  };
}

export function removeExceptionFromDraft(draft: ScheduleDraft, index: number) {
  return {
    ...draft,
    exceptions: draft.exceptions.filter((_, candidateIndex) => candidateIndex !== index),
  };
}

export function applyNaturalLanguageSchedule(draft: ScheduleDraft, value: string) {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");

  if (!text) {
    return undefined;
  }

  if (text === "always" || text === "always on") {
    return { ...draft, recurrenceMode: "always_on" as const };
  }

  const once = /^once (\d{4}-\d{2}-\d{2})(?: at)? (.+)$/.exec(text);

  if (once) {
    const time = parseTime(once[2]);

    return time
      ? { ...draft, recurrenceMode: "once" as const, recurrenceStartAt: `${once[1]}T${time}` }
      : undefined;
  }

  const range = parseTimeRange(text);

  if (!range) {
    return undefined;
  }

  if (text.startsWith("daily") || text.startsWith("every day")) {
    return recurrenceDraft(draft, "daily", range);
  }

  if (text.startsWith("weekday") || text.startsWith("weekdays")) {
    return {
      ...recurrenceDraft(draft, "weekly", range),
      daysOfWeek: weekdayDays,
    };
  }

  const weekly = /^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(text);

  if (weekly) {
    return {
      ...recurrenceDraft(draft, "weekly", range),
      daysOfWeek: [weekly[1] as ScheduleDayOfWeek],
    };
  }

  const monthly = /^monthly day (\d{1,2})\b/.exec(text);

  if (monthly) {
    return {
      ...recurrenceDraft(draft, "monthly", range),
      dayOfMonth: Math.min(31, Math.max(1, Number(monthly[1]))),
    };
  }

  return undefined;
}

function recurrenceFromDraft(draft: ScheduleDraft): ScheduleRecurrence {
  const interval = Math.max(1, Math.floor(draft.interval || 1));
  const options = recurrenceOptionsFromDraft(draft);

  if (draft.recurrenceMode === "manual") {
    return { mode: "manual", ...options };
  }

  if (draft.recurrenceMode === "once") {
    return {
      mode: "once",
      startsAt: isoFromLocalDateTime(draft.recurrenceStartAt) ?? new Date().toISOString(),
      ...options,
    };
  }

  if (draft.recurrenceMode === "daily") {
    return {
      endTime: draft.endTime,
      interval,
      mode: "daily",
      startTime: draft.startTime,
      ...options,
    };
  }

  if (draft.recurrenceMode === "weekly") {
    return {
      daysOfWeek: draft.daysOfWeek,
      endTime: draft.endTime,
      interval,
      mode: "weekly",
      startTime: draft.startTime,
      ...options,
    };
  }

  if (draft.recurrenceMode === "monthly") {
    return {
      dayOfMonth: Math.min(31, Math.max(1, Math.floor(draft.dayOfMonth || 1))),
      endTime: draft.endTime,
      interval,
      mode: "monthly",
      startTime: draft.startTime,
      ...options,
    };
  }

  return { mode: "always_on", ...options };
}

function recurrenceOptionsFromDraft(draft: ScheduleDraft) {
  const startEarlySeconds = positiveMinutes(draft.startEarlyMinutes) * 60;
  const stopLateSeconds = positiveMinutes(draft.stopLateMinutes) * 60;

  return {
    ...(draft.exceptions.length > 0 ? { exceptions: draft.exceptions } : {}),
    ...(startEarlySeconds > 0 ? { startEarlySeconds } : {}),
    ...(stopLateSeconds > 0 ? { stopLateSeconds } : {}),
  };
}

function recurrenceDraft(
  draft: ScheduleDraft,
  recurrenceMode: Extract<ScheduleRecurrence["mode"], "daily" | "monthly" | "weekly">,
  range: { endTime: string; startTime: string },
) {
  return {
    ...draft,
    endTime: range.endTime,
    interval: 1,
    recurrenceMode,
    startTime: range.startTime,
  };
}

function nextRunAtFromDraft(draft: ScheduleDraft, recurrence: ScheduleRecurrence) {
  if (recurrence.mode === "once") {
    return recurrence.startsAt;
  }

  if (recurrence.mode === "manual") {
    return isoFromLocalDateTime(draft.nextRunAt);
  }

  return undefined;
}

function applyRecurrenceToDraft(draft: ScheduleDraft, recurrence: ScheduleRecurrence) {
  const nextDraft = { ...draft, recurrenceMode: recurrence.mode };

  nextDraft.exceptions = recurrence.exceptions ?? [];
  nextDraft.startEarlyMinutes = secondsToMinutes(recurrence.startEarlySeconds);
  nextDraft.stopLateMinutes = secondsToMinutes(recurrence.stopLateSeconds);

  if (recurrence.mode === "once") {
    return {
      ...nextDraft,
      recurrenceStartAt: localDateTimeInput(recurrence.startsAt),
    };
  }

  if (
    recurrence.mode === "daily" ||
    recurrence.mode === "weekly" ||
    recurrence.mode === "monthly"
  ) {
    nextDraft.endTime = recurrence.endTime;
    nextDraft.interval = recurrence.interval;
    nextDraft.startTime = recurrence.startTime;
  }

  if (recurrence.mode === "weekly") {
    nextDraft.daysOfWeek = recurrence.daysOfWeek;
  }

  if (recurrence.mode === "monthly") {
    nextDraft.dayOfMonth = recurrence.dayOfMonth;
  }

  return nextDraft;
}

function uniqueTags(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function positiveMinutes(value: number) {
  return Math.max(0, Math.floor(value || 0));
}

function secondsToMinutes(value: number | undefined) {
  return value ? Math.floor(value / 60) : 0;
}

function intervalLabel(interval: number, unit: string) {
  return interval === 1 ? unit : `${interval} ${unit}s`;
}

function dayList(days: ScheduleDayOfWeek[]) {
  return days.map((day) => dayOptions.find((option) => option.id === day)?.label ?? day).join(", ");
}

function parseTimeRange(value: string) {
  const match =
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/.exec(
      value,
    );

  if (!match) {
    return undefined;
  }

  const startTime = parseTime(match[1]);
  const endTime = parseTime(match[2]);

  return startTime && endTime ? { endTime, startTime } : undefined;
}

function parseTime(value: string | undefined) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(value?.trim() ?? "");

  if (!match) {
    return undefined;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const meridiem = match[3];

  if (hours > 23 || minutes > 59 || (meridiem && hours > 12)) {
    return undefined;
  }

  if (meridiem === "pm" && hours < 12) {
    hours += 12;
  }

  if (meridiem === "am" && hours === 12) {
    hours = 0;
  }

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function compareExceptions(
  left: NonNullable<ScheduleRecurrence["exceptions"]>[number],
  right: NonNullable<ScheduleRecurrence["exceptions"]>[number],
) {
  const leftDate = left.action === "skip" ? left.date : left.startDate;
  const rightDate = right.action === "skip" ? right.date : right.startDate;

  return leftDate.localeCompare(rightDate);
}

function exceptionLabel(exception: NonNullable<ScheduleRecurrence["exceptions"]>[number]) {
  if (exception.action === "skip") {
    return `Skip ${exception.date}`;
  }

  return `Pause ${exception.startDate}-${exception.endDate}`;
}
