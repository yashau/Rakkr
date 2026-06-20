import { randomUUID } from "node:crypto";
import type {
  RecordingProfile,
  RecordingSummary,
  ScheduleOccurrencePreview,
  ScheduleRecurrence,
  ScheduleSummary,
} from "@rakkr/shared";

type ScheduleNode = {
  alias: string;
  hostname: string;
  id: string;
  location: {
    room: string;
    site: string;
  };
};

interface LocalDate {
  day: number;
  month: number;
  year: number;
}

export interface ScheduledRecordingTrack {
  durationSeconds?: number;
  offsetSeconds: number;
  trackGroupId?: string;
  trackIndex?: number;
  trackTotal?: number;
}

const dayIndexes = {
  friday: 4,
  monday: 0,
  saturday: 5,
  sunday: 6,
  thursday: 3,
  tuesday: 1,
  wednesday: 2,
} as const;
const weekdayNames = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const oneDayMs = 24 * 60 * 60 * 1000;
const scanDayLimit = 3_660;
const scanMonthLimit = 240;

export function materializeScheduledRecording(
  schedule: ScheduleSummary,
  node: ScheduleNode,
  now = new Date(),
  track: ScheduledRecordingTrack = { offsetSeconds: 0 },
): RecordingSummary {
  const trackStart = new Date(now.getTime() + track.offsetSeconds * 1_000);
  const context = templateContext(schedule, node, trackStart);
  const baseName = safeText(renderTemplate(schedule.titleTemplate, context));

  return {
    cached: false,
    durationSeconds: 0,
    folder: safePath(renderTemplate(schedule.folderTemplate, context)),
    healthStatus: "unknown",
    id: `rec_${randomUUID()}`,
    name: track.trackTotal
      ? `${baseName} - Track ${track.trackIndex} of ${track.trackTotal}`
      : baseName,
    nodeId: schedule.nodeId,
    recordedAt: trackStart.toISOString(),
    recordingProfileId: schedule.recordingProfileId,
    retentionPolicyId: schedule.retentionPolicyId,
    scheduleId: schedule.id,
    source: "schedule",
    status: "recording",
    tags: uniqueTags(schedule.tags),
    trackGroupId: track.trackGroupId,
    trackIndex: track.trackIndex,
    trackTotal: track.trackTotal,
    uploadPolicyId: schedule.uploadPolicyId,
    watchdogPolicyId: schedule.watchdogPolicyId,
  };
}

export function scheduleRecordingTrackPlans(
  schedule: ScheduleSummary,
  profile?: RecordingProfile,
): ScheduledRecordingTrack[] {
  const durationSeconds = scheduleRecordingDurationSeconds(schedule);
  const maxTrackSeconds = profile?.maxTrackSeconds;

  if (!durationSeconds || !maxTrackSeconds || durationSeconds <= maxTrackSeconds) {
    return [{ durationSeconds, offsetSeconds: 0 }];
  }

  const trackTotal = Math.ceil(durationSeconds / maxTrackSeconds);
  const trackGroupId = `track_${randomUUID()}`;

  return Array.from({ length: trackTotal }, (_, index) => {
    const offsetSeconds = index * maxTrackSeconds;

    return {
      durationSeconds: Math.min(maxTrackSeconds, durationSeconds - offsetSeconds),
      offsetSeconds,
      trackGroupId,
      trackIndex: index + 1,
      trackTotal,
    };
  });
}

export function scheduleRecordingDurationSeconds(schedule: ScheduleSummary) {
  const recurrence = schedule.recurrence;

  if (
    recurrence.mode !== "daily" &&
    recurrence.mode !== "weekly" &&
    recurrence.mode !== "monthly"
  ) {
    return undefined;
  }

  return (
    timeRangeSeconds(recurrence.startTime, recurrence.endTime) +
    recurrenceStartEarlySeconds(recurrence) +
    recurrenceStopLateSeconds(recurrence)
  );
}

export function previewScheduleOccurrences(schedule: ScheduleSummary, limit = 5, now = new Date()) {
  const occurrences: ScheduleOccurrencePreview[] = [];
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  let nextRunAt =
    schedule.nextRunAt ??
    nextRunAtForRecurrence(schedule.recurrence, schedule.timezone, undefined, now);

  while (nextRunAt && occurrences.length < safeLimit) {
    occurrences.push(scheduleOccurrencePreview(schedule, nextRunAt));

    const updates = advanceScheduleAfterRun(
      { ...schedule, nextRunAt },
      new Date(Date.parse(nextRunAt)),
    );

    nextRunAt = updates.nextRunAt;
  }

  return occurrences;
}

export function scheduleExecutionSnapshot(schedule: ScheduleSummary) {
  return {
    folderTemplate: schedule.folderTemplate,
    nextRunAt: schedule.nextRunAt,
    recurrence: schedule.recurrence,
    recordingProfileId: schedule.recordingProfileId,
    retentionPolicyId: schedule.retentionPolicyId,
    tags: schedule.tags,
    titleTemplate: schedule.titleTemplate,
    uploadPolicyId: schedule.uploadPolicyId,
    watchdogPolicyId: schedule.watchdogPolicyId,
  };
}

export function recordingMetadataSnapshot(recording: RecordingSummary) {
  return {
    folder: recording.folder,
    name: recording.name,
    recordingProfileId: recording.recordingProfileId,
    retentionPolicyId: recording.retentionPolicyId,
    tags: recording.tags,
    trackGroupId: recording.trackGroupId,
    trackIndex: recording.trackIndex,
    trackTotal: recording.trackTotal,
    uploadPolicyId: recording.uploadPolicyId,
    watchdogPolicyId: recording.watchdogPolicyId,
  };
}

export function scheduleIsDue(schedule: ScheduleSummary, now = new Date()) {
  return (
    schedule.enabled &&
    Boolean(schedule.nextRunAt) &&
    Date.parse(schedule.nextRunAt ?? "") <= now.getTime()
  );
}

export function scheduleOccurrenceIsSkipped(schedule: ScheduleSummary) {
  const occurrenceDate = scheduleOccurrenceDate(schedule);

  return occurrenceDate ? isSkippedDateIso(schedule.recurrence, occurrenceDate) : false;
}

export function skipNextScheduleOccurrence(schedule: ScheduleSummary) {
  const occurrenceDate = scheduleOccurrenceDate(schedule);

  if (!schedule.nextRunAt || !occurrenceDate) {
    return undefined;
  }

  const recurrence = recurrenceWithSkip(schedule.recurrence, occurrenceDate);
  const updates = {
    recurrence,
    ...advanceScheduleAfterRun(
      { ...schedule, recurrence },
      new Date(Date.parse(schedule.nextRunAt)),
    ),
  };

  return {
    occurrenceDate,
    updates,
  };
}

export function advanceScheduleAfterRun(schedule: ScheduleSummary, now = new Date()) {
  if (schedule.recurrence.mode === "manual") {
    return { nextRunAt: undefined };
  }

  if (schedule.recurrence.mode === "once") {
    return {
      enabled: false,
      nextRunAt: undefined,
    };
  }

  if (schedule.recurrence.mode === "always_on") {
    return { nextRunAt: undefined };
  }

  return {
    nextRunAt: nextRunAtForRecurrence(
      schedule.recurrence,
      schedule.timezone,
      undefined,
      new Date(now.getTime() + 60_000),
      schedule.nextRunAt ?? now.toISOString(),
    ),
  };
}

export function retryScheduleAfterFailure(now = new Date()) {
  const retrySeconds = positiveInteger(process.env.RAKKR_SCHEDULE_FAILURE_RETRY_SECONDS, 300);

  return new Date(now.getTime() + retrySeconds * 1_000).toISOString();
}

export function nextRunAtForRecurrence(
  recurrence: ScheduleRecurrence,
  timeZone: string,
  fallback: string | undefined,
  after = new Date(),
  previousRunAt?: string,
) {
  if (recurrence.mode === "manual") {
    return validIsoOrUndefined(fallback);
  }

  if (recurrence.mode === "once") {
    return runAtForCandidate(new Date(recurrence.startsAt), recurrence).toISOString();
  }

  if (recurrence.mode === "always_on") {
    return previousRunAt ? undefined : after.toISOString();
  }

  if (recurrence.mode === "daily") {
    return nextDailyRunAt(recurrence, timeZone, after, previousRunAt);
  }

  if (recurrence.mode === "weekly") {
    return nextWeeklyRunAt(recurrence, timeZone, after, previousRunAt);
  }

  return nextMonthlyRunAt(recurrence, timeZone, after, previousRunAt);
}

export function uniqueTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function nextDailyRunAt(
  recurrence: Extract<ScheduleRecurrence, { mode: "daily" }>,
  timeZone: string,
  after: Date,
  previousRunAt?: string,
) {
  const anchor = previousRunAt
    ? scheduledLocalDateFromRunAt(previousRunAt, recurrence, timeZone)
    : localDate(after, timeZone);
  const start = previousRunAt ? addDays(anchor, 1) : anchor;

  for (let offset = 0; offset <= scanDayLimit; offset += 1) {
    const candidateDate = addDays(start, offset);

    if (daysBetween(anchor, candidateDate) % recurrence.interval !== 0) {
      continue;
    }

    if (isSkippedDate(recurrence, candidateDate)) {
      continue;
    }

    const runAt = runAtForCandidate(
      localDateTimeToUtc(candidateDate, recurrence.startTime, timeZone),
      recurrence,
    );

    if (runAt.getTime() > after.getTime()) {
      return runAt.toISOString();
    }
  }

  return undefined;
}

function nextWeeklyRunAt(
  recurrence: Extract<ScheduleRecurrence, { mode: "weekly" }>,
  timeZone: string,
  after: Date,
  previousRunAt?: string,
) {
  const afterDate = previousRunAt
    ? scheduledLocalDateFromRunAt(previousRunAt, recurrence, timeZone)
    : localDate(after, timeZone);
  const anchorWeek = weekStart(afterDate);
  const start = previousRunAt ? addDays(afterDate, 1) : afterDate;
  const selectedDays = new Set<number>(recurrence.daysOfWeek.map((day) => dayIndexes[day]));

  for (let offset = 0; offset <= scanDayLimit; offset += 1) {
    const candidateDate = addDays(start, offset);

    if (!selectedDays.has(dayIndex(candidateDate))) {
      continue;
    }

    if (weeksBetween(anchorWeek, weekStart(candidateDate)) % recurrence.interval !== 0) {
      continue;
    }

    if (isSkippedDate(recurrence, candidateDate)) {
      continue;
    }

    const runAt = runAtForCandidate(
      localDateTimeToUtc(candidateDate, recurrence.startTime, timeZone),
      recurrence,
    );

    if (runAt.getTime() > after.getTime()) {
      return runAt.toISOString();
    }
  }

  return undefined;
}

function nextMonthlyRunAt(
  recurrence: Extract<ScheduleRecurrence, { mode: "monthly" }>,
  timeZone: string,
  after: Date,
  previousRunAt?: string,
) {
  const anchorDate = previousRunAt
    ? scheduledLocalDateFromRunAt(previousRunAt, recurrence, timeZone)
    : localDate(after, timeZone);
  const anchorMonth = monthIndex(anchorDate);
  const firstOffset = previousRunAt ? recurrence.interval : 0;

  for (let offset = firstOffset; offset <= scanMonthLimit; offset += 1) {
    const candidateMonth = anchorMonth + offset;

    if ((candidateMonth - anchorMonth) % recurrence.interval !== 0) {
      continue;
    }

    const year = Math.floor(candidateMonth / 12);
    const month = (candidateMonth % 12) + 1;
    const candidateDate = {
      day: Math.min(recurrence.dayOfMonth, daysInMonth(year, month)),
      month,
      year,
    };
    if (isSkippedDate(recurrence, candidateDate)) {
      continue;
    }

    const candidate = runAtForCandidate(
      localDateTimeToUtc(candidateDate, recurrence.startTime, timeZone),
      recurrence,
    );

    if (candidate.getTime() > after.getTime()) {
      return candidate.toISOString();
    }
  }

  return undefined;
}

function templateContext(schedule: ScheduleSummary, node: ScheduleNode, now: Date) {
  const clock = scheduleClock(now, schedule.timezone);

  return new Map([
    ["date", clock.date],
    ["node.alias", node.alias],
    ["node.hostname", node.hostname],
    ["node.id", node.id],
    ["room", schedule.room],
    ["schedule.id", schedule.id],
    ["schedule.name", schedule.name],
    ["site", node.location.site],
    ["time", clock.time],
    ["timestamp", now.toISOString()],
  ]);
}

function scheduleOccurrenceDate(schedule: ScheduleSummary) {
  if (!schedule.nextRunAt) {
    return undefined;
  }

  const scheduledDate = scheduledLocalDateFromRunAt(
    schedule.nextRunAt,
    schedule.recurrence,
    schedule.timezone,
  );

  return localDateIso(scheduledDate);
}

function scheduleOccurrencePreview(
  schedule: ScheduleSummary,
  recordingStartAt: string,
): ScheduleOccurrencePreview {
  const scheduledStartAt = new Date(
    Date.parse(recordingStartAt) + recurrenceStartEarlySeconds(schedule.recurrence) * 1_000,
  );
  const recordingEndAt = scheduleRecordingEndAt(schedule.recurrence, scheduledStartAt);

  return {
    ...(recordingEndAt ? { recordingEndAt: recordingEndAt.toISOString() } : {}),
    recordingStartAt,
    scheduledStartAt: scheduledStartAt.toISOString(),
  };
}

function scheduleRecordingEndAt(recurrence: ScheduleRecurrence, scheduledStartAt: Date) {
  if (
    recurrence.mode !== "daily" &&
    recurrence.mode !== "weekly" &&
    recurrence.mode !== "monthly"
  ) {
    return undefined;
  }

  return new Date(
    scheduledStartAt.getTime() +
      (timeRangeSeconds(recurrence.startTime, recurrence.endTime) +
        recurrenceStopLateSeconds(recurrence)) *
        1_000,
  );
}

function scheduledLocalDateFromRunAt(
  runAt: string,
  recurrence: ScheduleRecurrence,
  timeZone: string,
) {
  const scheduledAt = new Date(Date.parse(runAt) + recurrenceStartEarlySeconds(recurrence) * 1_000);

  return localDate(scheduledAt, timeZone);
}

function recurrenceWithSkip(recurrence: ScheduleRecurrence, date: string): ScheduleRecurrence {
  const exceptions = [
    ...exceptionList(recurrence).filter(
      (exception) => !(exception.action === "skip" && exception.date === date),
    ),
    { action: "skip" as const, date },
  ].sort((left, right) => exceptionStartDate(left).localeCompare(exceptionStartDate(right)));

  return {
    ...recurrence,
    exceptions,
  };
}

function exceptionList(recurrence: ScheduleRecurrence) {
  return recurrence.exceptions ?? [];
}

function exceptionStartDate(exception: ReturnType<typeof exceptionList>[number]) {
  return exception.action === "skip" ? exception.date : exception.startDate;
}

function isSkippedDate(recurrence: ScheduleRecurrence, date: LocalDate) {
  return isSkippedDateIso(recurrence, localDateIso(date));
}

function isSkippedDateIso(recurrence: ScheduleRecurrence, date: string) {
  return exceptionList(recurrence).some((exception) => {
    if (exception.action === "skip") {
      return exception.date === date;
    }

    return exception.startDate <= date && date <= exception.endDate;
  });
}

function runAtForCandidate(candidate: Date, recurrence: ScheduleRecurrence) {
  return new Date(candidate.getTime() - recurrenceStartEarlySeconds(recurrence) * 1_000);
}

function recurrenceStartEarlySeconds(recurrence: ScheduleRecurrence) {
  return recurrence.startEarlySeconds ?? 0;
}

function recurrenceStopLateSeconds(recurrence: ScheduleRecurrence) {
  return recurrence.stopLateSeconds ?? 0;
}

function timeRangeSeconds(startTime: string, endTime: string) {
  const start = secondsFromTime(startTime);
  const end = secondsFromTime(endTime);
  const duration = end > start ? end - start : end + 86_400 - start;

  return Math.max(1, duration);
}

function secondsFromTime(value: string) {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);

  return hours * 3_600 + minutes * 60;
}

function renderTemplate(template: string, values: Map<string, string>) {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey: string) => {
    const key = rawKey.trim();

    return values.get(key) ?? "";
  });
}

function scheduleClock(now: Date, timeZone: string) {
  const parts = dateTimeParts(now, timeZone);

  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}${pad(parts.minute)}`,
  };
}

function safePath(value: string) {
  const folder = value
    .split(/[\\/]+/)
    .map(safeText)
    .filter(Boolean)
    .join("/");

  return folder || "Scheduled";
}

function safeText(value: string) {
  const text = value
    .replace(/[<>:"\\|?*]+/g, "-")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\t", " ")
    .replace(/\s+/g, " ")
    .trim();

  return text || "Scheduled Recording";
}

function validIsoOrUndefined(value: string | undefined) {
  return value ? new Date(value).toISOString() : undefined;
}

function localDate(date: Date, timeZone: string): LocalDate {
  const parts = dateTimeParts(date, timeZone);

  return {
    day: parts.day,
    month: parts.month,
    year: parts.year,
  };
}

function localDateTimeToUtc(date: LocalDate, time: string, timeZone: string) {
  const [hour, minute] = time.split(":").map(Number);
  const wantedUtc = Date.UTC(date.year, date.month - 1, date.day, hour ?? 0, minute ?? 0);
  let candidate = wantedUtc;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const offset = zonedOffsetMs(new Date(candidate), timeZone);
    candidate = wantedUtc - offset;
  }

  return new Date(candidate);
}

function zonedOffsetMs(date: Date, timeZone: string) {
  const parts = dateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
}

function dateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    weekday: "long",
    year: "numeric",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";

  return {
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    month: Number(value("month")),
    second: Number(value("second")),
    weekday: value("weekday").toLowerCase(),
    year: Number(value("year")),
  };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return {
    day: next.getUTCDate(),
    month: next.getUTCMonth() + 1,
    year: next.getUTCFullYear(),
  };
}

function daysBetween(left: LocalDate, right: LocalDate) {
  const leftUtc = Date.UTC(left.year, left.month - 1, left.day);
  const rightUtc = Date.UTC(right.year, right.month - 1, right.day);

  return Math.floor((rightUtc - leftUtc) / oneDayMs);
}

function weekStart(date: LocalDate) {
  return addDays(date, -dayIndex(date));
}

function weeksBetween(left: LocalDate, right: LocalDate) {
  return Math.floor(daysBetween(left, right) / 7);
}

function dayIndex(date: LocalDate) {
  const weekday = dateTimeParts(
    new Date(Date.UTC(date.year, date.month - 1, date.day, 12)),
    "UTC",
  ).weekday;

  return Math.max(0, weekdayNames.indexOf(weekday));
}

function monthIndex(date: LocalDate) {
  return date.year * 12 + date.month - 1;
}

function localDateIso(date: LocalDate) {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
