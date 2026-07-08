import { z } from "zod";

import { accessGroupIdSchema } from "./access-groups.js";
import {
  audioCaptureBackendSchema,
  ianaTimeZoneSchema,
  isoDateSchema,
  isoDateTimeSchema,
  timeOfDaySchema,
} from "./base.js";
import { captureChannelSelectionSchema, channelModeSchema } from "./channels.js";

export const scheduleDayOfWeekSchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export const scheduleExceptionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("skip"),
    date: isoDateSchema,
    reason: z.string().trim().max(240).optional(),
  }),
  z
    .object({
      action: z.literal("pause"),
      endDate: isoDateSchema,
      reason: z.string().trim().max(240).optional(),
      startDate: isoDateSchema,
    })
    .refine((value) => value.startDate <= value.endDate, "Pause start must be before end"),
]);
const scheduleRecurrenceOptions = {
  exceptions: z.array(scheduleExceptionSchema).max(366).optional(),
  startEarlySeconds: z.number().int().nonnegative().max(86_400).optional(),
  stopLateSeconds: z.number().int().nonnegative().max(86_400).optional(),
};
export const scheduleRecurrenceSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("manual"),
    ...scheduleRecurrenceOptions,
  }),
  z.object({
    // Optional fixed recording length (seconds) for a single-fire schedule.
    // Set when a timed recurring occurrence is moved into a one-off so the
    // moved recording keeps its original duration; absent = open-ended.
    durationSeconds: z.number().int().positive().max(2_678_400).optional(),
    mode: z.literal("once"),
    startsAt: isoDateTimeSchema,
    ...scheduleRecurrenceOptions,
  }),
  z.object({
    endTime: timeOfDaySchema,
    interval: z.number().int().positive(),
    mode: z.literal("daily"),
    startTime: timeOfDaySchema,
    ...scheduleRecurrenceOptions,
  }),
  z.object({
    daysOfWeek: z.array(scheduleDayOfWeekSchema).min(1).max(7),
    endTime: timeOfDaySchema,
    interval: z.number().int().positive(),
    mode: z.literal("weekly"),
    startTime: timeOfDaySchema,
    ...scheduleRecurrenceOptions,
  }),
  z.object({
    dayOfMonth: z.number().int().min(1).max(31),
    endTime: timeOfDaySchema,
    interval: z.number().int().positive(),
    mode: z.literal("monthly"),
    startTime: timeOfDaySchema,
    ...scheduleRecurrenceOptions,
  }),
  z.object({
    mode: z.literal("always_on"),
    ...scheduleRecurrenceOptions,
  }),
]);

export const scheduleSummarySchema = z.object({
  assignedGroupIds: z.array(accessGroupIdSchema).default([]),
  assignedUserIds: z.array(z.string().trim().min(1).max(160)).default([]),
  captureBackend: audioCaptureBackendSchema.optional(),
  captureChannelSelection: captureChannelSelectionSchema.optional(),
  captureInterfaceId: z.string().min(1).optional(),
  channelMode: channelModeSchema.optional(),
  enabled: z.boolean(),
  folderTemplate: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  nextRunAt: isoDateTimeSchema.optional(),
  nodeId: z.string().min(1),
  recurrence: scheduleRecurrenceSchema.default({ mode: "manual" }),
  recordingProfileId: z.string().min(1),
  retentionPolicyId: z.string().min(1).default("retention-keep-controller-cache"),
  room: z.string().min(1),
  roomId: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)),
  timezone: z.string().min(1),
  titleTemplate: z.string().min(1),
  uploadPolicyIds: z.array(z.string().min(1)).default([]),
  watchdogPolicyId: z.string().min(1),
});
export const scheduleInputSchema = z.object({
  assignedGroupIds: z.array(accessGroupIdSchema).max(128).default([]),
  assignedUserIds: z.array(z.string().trim().min(1).max(160)).max(256).default([]),
  captureBackend: audioCaptureBackendSchema.nullable().optional(),
  captureChannelSelection: captureChannelSelectionSchema.nullable().optional(),
  captureInterfaceId: z.string().trim().min(1).max(160).nullable().optional(),
  channelMode: channelModeSchema.nullable().optional(),
  enabled: z.boolean().default(true),
  folderTemplate: z.string().trim().min(1).max(500),
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160),
  nextRunAt: isoDateTimeSchema.optional(),
  nodeId: z.string().trim().min(1).max(160),
  recurrence: scheduleRecurrenceSchema.optional(),
  recordingProfileId: z.string().trim().min(1).max(160),
  retentionPolicyId: z.string().trim().min(1).max(160).default("retention-keep-controller-cache"),
  room: z.string().trim().min(1).max(160),
  roomId: z.string().trim().min(1).max(160).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(64).default([]),
  timezone: ianaTimeZoneSchema,
  titleTemplate: z.string().trim().min(1).max(500),
  // Capped + deduped on write: each recording fans out to one upload queue item
  // per id, so an uncapped list multiplies queue work per recording (audit R3-4).
  uploadPolicyIds: z.array(z.string().trim().min(1).max(160)).max(32).default([]),
  watchdogPolicyId: z.string().trim().min(1).max(160),
});
export const scheduleUpdateSchema = z
  .object({
    assignedGroupIds: z.array(accessGroupIdSchema).max(128).optional(),
    assignedUserIds: z.array(z.string().trim().min(1).max(160)).max(256).optional(),
    captureBackend: audioCaptureBackendSchema.nullable().optional(),
    captureChannelSelection: captureChannelSelectionSchema.nullable().optional(),
    captureInterfaceId: z.string().trim().min(1).max(160).nullable().optional(),
    channelMode: channelModeSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    folderTemplate: z.string().trim().min(1).max(500).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    nextRunAt: isoDateTimeSchema.optional(),
    nodeId: z.string().trim().min(1).max(160).optional(),
    recurrence: scheduleRecurrenceSchema.optional(),
    recordingProfileId: z.string().trim().min(1).max(160).optional(),
    retentionPolicyId: z.string().trim().min(1).max(160).optional(),
    room: z.string().trim().min(1).max(160).optional(),
    roomId: z.string().trim().min(1).max(160).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
    timezone: ianaTimeZoneSchema.optional(),
    titleTemplate: z.string().trim().min(1).max(500).optional(),
    uploadPolicyIds: z.array(z.string().trim().min(1).max(160)).max(32).optional(),
    watchdogPolicyId: z.string().trim().min(1).max(160).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one schedule field is required");
export const scheduleOccurrencePreviewSchema = z.object({
  recordingEndAt: isoDateTimeSchema.optional(),
  recordingStartAt: isoDateTimeSchema,
  scheduledStartAt: isoDateTimeSchema.optional(),
});
export const scheduleRecurrenceModeSchema = z.enum([
  "manual",
  "once",
  "daily",
  "weekly",
  "monthly",
  "always_on",
]);
// A single occurrence event returned by the calendar endpoint. Extends the
// occurrence preview with the owning schedule's identity so the calendar can
// render and route interactions (recurrenceMode picks the drag behavior:
// once -> move in place, recurring -> split a single instance).
export const scheduleCalendarOccurrenceSchema = scheduleOccurrencePreviewSchema.extend({
  enabled: z.boolean(),
  nodeId: z.string().min(1),
  recurrenceMode: scheduleRecurrenceModeSchema,
  room: z.string().min(1),
  scheduleId: z.string().min(1),
  scheduleName: z.string().min(1),
  // The schedule's IANA timezone, so the calendar groups each chip on the
  // SCHEDULE-local day (matching the backend skip/occurrence day) rather than the
  // viewer's browser-local day when the two differ (see calendar-grid groupByLocalDay).
  timezone: z.string().min(1).max(80),
});
export const scheduleCalendarResponseSchema = z.object({
  data: z.array(scheduleCalendarOccurrenceSchema),
  meta: z.object({
    end: isoDateTimeSchema,
    occurrenceCount: z.number().int().nonnegative(),
    scheduleCount: z.number().int().nonnegative(),
    start: isoDateTimeSchema,
    truncated: z.boolean(),
  }),
});

export type ScheduleCalendarOccurrence = z.infer<typeof scheduleCalendarOccurrenceSchema>;
export type ScheduleCalendarResponse = z.infer<typeof scheduleCalendarResponseSchema>;
export type ScheduleDayOfWeek = z.infer<typeof scheduleDayOfWeekSchema>;
export type ScheduleException = z.infer<typeof scheduleExceptionSchema>;
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export type ScheduleOccurrencePreview = z.infer<typeof scheduleOccurrencePreviewSchema>;
export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;
export type ScheduleRecurrenceMode = z.infer<typeof scheduleRecurrenceModeSchema>;
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;
