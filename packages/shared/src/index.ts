import { z } from "zod";

import {
  dbfsSchema,
  healthSeveritySchema,
  ianaTimeZoneSchema,
  isoDateTimeSchema,
  uploadProviderSchema,
  uploadQueueStatusSchema,
} from "./base.js";
import { captureChannelSelectionSchema, channelModeSchema } from "./channels.js";
import { recordingEnhancementSchema } from "./enhancement.js";
import { recordingChunkSchema } from "./recording-chunks.js";
export * from "./base.js";
export * from "./channels.js";
export * from "./enhancement.js";
export * from "./oidc.js";
export * from "./pagination.js";
export * from "./recording-chunks.js";
export * from "./recording-job-summary.js";
export * from "./room-capabilities.js";
export * from "./rooms.js";
export * from "./upload-providers.js";
export * from "./watchdog-policy.js";

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const audioCaptureBackendSchema = z.enum(["alsa", "jack", "pipewire"]);
const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}$/);

export const nodeStatusSchema = z.enum(["online", "offline", "degraded", "recording", "alerting"]);

export const healthEventStatusSchema = z.enum(["open", "acknowledged", "suppressed", "resolved"]);

export const recordingSourceSchema = z.enum(["ad_hoc", "schedule"]);
export const recordingStatusSchema = z.enum([
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
  "partial",
]);
export const recordingJobStatusSchema = z.enum([
  "queued",
  "running",
  "stop_requested",
  "cancelled",
  "completed",
  "failed",
]);

export const templateAssignmentTargetSchema = z.enum(["interface", "node"]);

export const permissions = [
  "audit:read",
  "auth:manage",
  "health:acknowledge",
  "health:read",
  "listen:monitor",
  "metrics:read",
  "node:control",
  "node:manage",
  "node:read",
  "recording:control",
  "recording:create",
  "recording:delete",
  "recording:download",
  "recording:edit",
  "recording:playback",
  "recording:read",
  "schedule:manage",
  "schedule:read",
  "settings:manage",
  "settings:read",
  "system:admin",
] as const;

export const roles = ["owner", "admin", "operator", "viewer", "auditor"] as const;
export type Permission = (typeof permissions)[number];
export type Role = (typeof roles)[number];
export const permissionSchema = z.enum(permissions);
export const roleSchema = z.enum(roles);
export const accessPolicyEffectSchema = z.enum(["allow", "deny"]);
export const accessPolicySubjectTypeSchema = z.enum(["user", "group", "everyone"]);
export const accessGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export const accessGroupIdSchema = z.string().trim().min(1).max(120);
export const resourceGrantSchema = z.object({
  resourceId: z.string().min(1),
  resourceType: z.string().min(1),
});
export const accessPolicySchema = z.object({
  effect: accessPolicyEffectSchema,
  id: z.string().min(1),
  reason: z.string().optional(),
  resourceId: z.string().min(1),
  resourceType: z.string().min(1),
  subjectId: z.string().optional(),
  subjectType: accessPolicySubjectTypeSchema,
});
export const accessPolicyInputSchema = accessPolicySchema.omit({ id: true });
export const rolePermissions: Record<Role, readonly Permission[]> = {
  admin: permissions.filter((permission) => permission !== "system:admin"),
  auditor: ["audit:read", "health:read", "metrics:read", "recording:read"],
  operator: [
    "health:acknowledge",
    "health:read",
    "listen:monitor",
    "metrics:read",
    "node:control",
    "node:read",
    "recording:control",
    "recording:create",
    "recording:download",
    "recording:edit",
    "recording:playback",
    "recording:read",
    "schedule:manage",
    "schedule:read",
    "settings:read",
  ],
  owner: permissions,
  viewer: [
    "health:read",
    "metrics:read",
    "node:read",
    "recording:download",
    "recording:playback",
    "recording:read",
    "schedule:read",
    "settings:read",
  ],
};

export function hasPermission(role: Role, permission: Permission) {
  return rolePermissions[role].includes(permission);
}

export function hasAnyPermission(role: Role, required: Permission[]) {
  return required.some((permission) => hasPermission(role, permission));
}

export const auditOutcomeSchema = z.enum(["allowed", "denied", "failed", "partial", "succeeded"]);
export const auditActorTypeSchema = z.enum(["node", "system", "user"]);

export const currentUserSchema = z.object({
  disabledAt: isoDateTimeSchema.optional(),
  email: z.string().email(),
  groups: z.array(accessGroupSchema),
  id: z.string().min(1),
  name: z.string().min(1),
  permissions: z.array(permissionSchema),
  provider: z.enum(["local", "oidc"]),
  resourceGrants: z.array(resourceGrantSchema),
  roles: z.array(roleSchema),
});

export const auditEventSchema = z.object({
  action: z.string().min(1),
  actor: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    roles: z.array(roleSchema),
    type: auditActorTypeSchema,
  }),
  actorContext: z.object({
    ipAddress: z.string().optional(),
    sessionId: z.string().optional(),
    userAgent: z.string().optional(),
  }),
  after: z.record(z.string(), z.unknown()).optional(),
  before: z.record(z.string(), z.unknown()).optional(),
  correlationIds: z.record(z.string(), z.string()).optional(),
  createdAt: isoDateTimeSchema,
  details: z.record(z.string(), z.unknown()),
  id: z.string().min(1),
  outcome: auditOutcomeSchema,
  permission: permissionSchema.optional(),
  reason: z.string().optional(),
  target: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().min(1),
  }),
});

export const audioChannelSchema = z.object({
  alias: z.string().min(1),
  index: z.number().int().positive(),
});

export const audioInterfaceSchema = z.object({
  absent: z.boolean().optional(), // flagged absent by inventory reconcile; see node-store
  alias: z.string().min(1),
  backend: z.enum(["alsa", "jack", "pipewire", "unknown"]),
  channelCount: z.number().int().nonnegative(),
  channels: z.array(audioChannelSchema),
  hardwarePath: z.string().min(1).optional(),
  id: z.string().min(1),
  sampleRates: z.array(z.number().int().positive()),
  serialNumber: z.string().min(1).optional(),
  systemName: z.string().min(1),
  systemRef: z.string().min(1).optional(),
});
export const nodeRuntimeSchema = z.object({
  architecture: z.string().min(1).optional(),
  audioBackends: z.array(z.enum(["alsa", "jack", "pipewire", "unknown"])).default([]),
  kernelRelease: z.string().min(1).optional(),
  osName: z.string().min(1).optional(),
  uptimeSeconds: z.number().int().nonnegative().optional(),
});
export const defaultNodeRecordingCapacity = { maxConcurrentRecordings: 1 } as const;
export const nodeRecordingCapacitySchema = z.object({
  maxConcurrentRecordings: z.number().int().positive().max(128),
});
export const nodeAudioCommandDefaultsSchema = z.object({
  captureArgsTemplate: z.string().trim().min(1).max(1000).optional(),
  captureBackend: audioCaptureBackendSchema.optional(),
  captureChannels: z.number().int().positive().max(256).optional(),
  captureCommand: z.string().trim().min(1).max(255).optional(),
  captureDevice: z.string().trim().min(1).max(255).optional(),
  captureFormat: z.string().trim().min(1).max(80).optional(),
  captureSampleRate: z.number().int().positive().max(384_000).optional(),
  meterArgsTemplate: z.string().trim().min(1).max(1000).optional(),
});

export const audioQualitySchema = z.object({
  channelCorrelation: z
    .object({
      peerChannelIndex: z.number().int().positive(),
      phase: z.enum(["same", "inverted"]),
      score: z.number().min(-1).max(1),
    })
    .optional(),
  broadbandNoiseScore: z.number().min(0).max(1).optional(),
  crestFactorDb: z.number().min(0).max(80),
  estimatedSnrDb: z.number().min(0).max(80).optional(),
  humScore: z.number().min(0).max(1).optional(),
  intelligibilityScore: z.number().min(0).max(1).optional(),
  noiseScore: z.number().min(0).max(1),
  speechLike: z.boolean(),
  speechScore: z.number().min(0).max(1),
  staticScore: z.number().min(0).max(1).optional(),
  zeroCrossingRate: z.number().min(0).max(1),
});
export const recorderNodeSchema = z.object({
  agentVersion: z.string().min(1),
  alias: z.string().min(1),
  hostname: z.string().min(1),
  id: z.string().min(1),
  interfaces: z.array(audioInterfaceSchema),
  ipAddresses: z.array(z.string().min(1)),
  lastSeenAt: isoDateTimeSchema,
  location: z.object({
    building: z.string().optional(),
    floor: z.string().optional(),
    room: z.string().min(1),
    site: z.string().min(1),
  }),
  // First-class room this node belongs to (source of truth for room identity;
  // location above is retained for display). Optional during the rooms rollout.
  roomId: z.string().min(1).optional(),
  notes: z.string().optional(),
  audioDefaults: nodeAudioCommandDefaultsSchema.optional(),
  recordingCapacity: nodeRecordingCapacitySchema.optional(),
  runtime: nodeRuntimeSchema.optional(),
  status: nodeStatusSchema,
  tags: z.array(z.string().min(1)),
});

export const audioLevelSchema = z.object({
  channelIndex: z.number().int().positive(),
  clipping: z.boolean(),
  label: z.string().min(1),
  peakDbfs: dbfsSchema,
  quality: audioQualitySchema.optional(),
  rmsDbfs: dbfsSchema,
});

export const meterFrameSchema = z.object({
  capturedAt: isoDateTimeSchema,
  interfaceId: z.string().min(1),
  // Real interfaces have at most a few dozen channels (X32 = 32). Cap the array
  // so a malformed/hostile node frame cannot wedge the watchdog's
  // `Math.max(...levels)` spread with a RangeError — which would poison the
  // stored `latest` frame and silently disable that node's watchdog.
  levels: z.array(audioLevelSchema).max(512),
  nodeId: z.string().min(1),
});

export const recordingProfileSchema = z.object({
  // This schema also parses persisted rows (recordingProfileFromRow), so it
  // stays permissive for any previously-stored value — the 512 kbps input
  // ceiling lives on recordingProfileUpdateSchema / the create route, not here
  // (a `.max` here would reject a legacy over-cap profile row on read).
  bitrateKbps: z.number().int().positive(),
  channelMode: channelModeSchema,
  // Length of each recording chunk in seconds. When set, the recording is
  // captured continuously and emitted as sequential chunk files that transfer
  // and upload as they close. Supersedes the deprecated `maxTrackSeconds`; read
  // both through `effectiveChunkSeconds`.
  chunkSeconds: z.number().int().positive().max(604_800).optional(),
  codec: z.enum(["mp3", "flac", "wav"]),
  enhancement: recordingEnhancementSchema.optional(),
  id: z.string().min(1),
  /** @deprecated superseded by `chunkSeconds`; retained one release for backfill. */
  maxTrackSeconds: z.number().int().positive().max(604_800).optional(),
  name: z.string().min(1),
  silenceDetectionEnabled: z.boolean(),
  silenceSkipEnabled: z.boolean(),
  vbr: z.boolean(),
});
export const recordingProfileUpdateSchema = z
  .object({
    bitrateKbps: z.number().int().positive().max(512).optional(),
    channelMode: channelModeSchema.optional(),
    chunkSeconds: z.number().int().positive().max(604_800).nullable().optional(),
    codec: z.enum(["mp3", "flac", "wav"]).optional(),
    enhancement: recordingEnhancementSchema.optional(),
    maxTrackSeconds: z.number().int().positive().max(604_800).nullable().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    silenceDetectionEnabled: z.boolean().optional(),
    silenceSkipEnabled: z.boolean().optional(),
    vbr: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one profile field is required");
// Resolve the active chunk length for a profile, preferring the new
// `chunkSeconds` knob and falling back to the deprecated `maxTrackSeconds`.
// Returns undefined when neither is set (recording stays a single file).
export function effectiveChunkSeconds(profile: RecordingProfile | undefined): number | undefined {
  const value = profile?.chunkSeconds ?? profile?.maxTrackSeconds ?? undefined;
  return typeof value === "number" && value > 0 ? value : undefined;
}
// Day the operator console's schedule calendar starts its week on.
export const weekStartDaySchema = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);
export const controllerSettingsSchema = z.object({
  controllerName: z.string().trim().min(1).max(160),
  weekStartsOn: weekStartDaySchema.default("monday"),
});
export const controllerSettingsUpdateSchema = z
  .object({
    controllerName: z.string().trim().min(1).max(160).optional(),
    weekStartsOn: weekStartDaySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one controller setting is required");
export const defaultControllerSettings = controllerSettingsSchema.parse({
  controllerName: "Rakkr Controller",
  weekStartsOn: "monday",
});
export const channelMapEntrySchema = z.object({
  included: z.boolean(),
  label: z.string().trim().min(1).max(160),
  outputChannelIndex: z.number().int().positive().optional(),
  sourceChannelIndex: z.number().int().positive(),
});
export const channelMapTemplateSchema = z.object({
  channelMode: channelModeSchema,
  entries: z.array(channelMapEntrySchema).min(1).max(128),
  id: z.string().min(1),
  name: z.string().min(1),
  promotedAt: isoDateTimeSchema.optional(),
  promotedFromTemplateId: z.string().min(1).optional(),
  revision: z.number().int().positive().default(1),
  tags: z.array(z.string().min(1)).default([]),
});
export const channelMapTemplateInputSchema = z.object({
  channelMode: channelModeSchema.default("mono_to_stereo_mix"),
  entries: z.array(channelMapEntrySchema).min(1).max(128),
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(80)).max(64).default([]),
});
export const channelMapTemplateUpdateSchema = z
  .object({
    channelMode: channelModeSchema.optional(),
    entries: z.array(channelMapEntrySchema).min(1).max(128).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one channel map field is required");
export const channelMapAssignmentHistorySchema = z.object({
  actorUserId: z.string().optional(),
  changedAt: isoDateTimeSchema,
  id: z.string().min(1),
  nextTemplateId: z.string().min(1),
  previousTemplateId: z.string().min(1).optional(),
  reason: z.enum(["assigned", "rolled_back"]),
});
export const channelMapTemplateAssignmentSchema = z.object({
  assignedAt: isoDateTimeSchema,
  history: z.array(channelMapAssignmentHistorySchema).default([]),
  id: z.string().min(1),
  targetId: z.string().min(1),
  targetType: templateAssignmentTargetSchema,
  templateId: z.string().min(1),
});
export const channelMapTemplateAssignmentInputSchema = z.object({
  targetId: z.string().trim().min(1).max(160),
  targetType: templateAssignmentTargetSchema,
  templateId: z.string().trim().min(1).max(160),
});
export const channelMapAssignmentTargetInputSchema = z.object({
  targetId: z.string().trim().min(1).max(160),
  targetType: templateAssignmentTargetSchema,
});
export const channelMapTemplateAssignmentBulkInputSchema = z.object({
  targets: z.array(channelMapAssignmentTargetInputSchema).min(1).max(128),
  templateId: z.string().trim().min(1).max(160),
});
export const channelMapAssignmentPlanStatusSchema = z.enum(["applied", "cancelled", "pending"]);
export const channelMapAssignmentPlanInputSchema = z.object({
  note: z.string().trim().max(500).optional(),
  targets: z.array(channelMapAssignmentTargetInputSchema).min(1).max(128),
  templateId: z.string().trim().min(1).max(160),
});
export const channelMapAssignmentPlanSchema = z.object({
  appliedAt: isoDateTimeSchema.optional(),
  appliedByUserId: z.string().optional(),
  cancelledAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  createdByUserId: z.string().optional(),
  id: z.string().min(1),
  note: z.string().optional(),
  status: channelMapAssignmentPlanStatusSchema,
  targets: z.array(channelMapAssignmentTargetInputSchema).min(1).max(128),
  templateId: z.string().min(1),
});
export const channelMapTemplateAssignmentRollbackInputSchema = z.object({
  targetId: z.string().trim().min(1).max(160),
  targetType: templateAssignmentTargetSchema,
});
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
  uploadPolicyIds: z.array(z.string().min(1)).default(["upload-policy-stub"]),
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
  uploadPolicyIds: z.array(z.string().trim().min(1).max(160)).default(["upload-policy-stub"]),
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
    uploadPolicyIds: z.array(z.string().trim().min(1).max(160)).optional(),
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

export const recordingSummarySchema = z.object({
  cached: z.boolean(),
  cachePath: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  chunks: z.array(recordingChunkSchema).optional(),
  chunkSeconds: z.number().int().positive().optional(),
  chunkTotal: z.number().int().positive().optional(),
  durationSeconds: z.number().int().nonnegative(),
  enhancedCachePath: z.string().min(1).optional(),
  rawCachePath: z.string().min(1).optional(),
  folder: z.string().min(1),
  healthStatus: z.enum(["healthy", "warning", "critical", "unknown"]),
  id: z.string().min(1),
  name: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
  recordedAt: isoDateTimeSchema,
  recordingProfileId: z.string().min(1).optional(),
  retentionPolicyId: z.string().min(1).optional(),
  scheduleId: z.string().min(1).optional(),
  source: recordingSourceSchema,
  status: recordingStatusSchema,
  tags: z.array(z.string().min(1)),
  transcriptSnippets: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  trackGroupId: z.string().min(1).optional(),
  trackIndex: z.number().int().positive().optional(),
  trackTotal: z.number().int().positive().optional(),
  uploadPolicyIds: z.array(z.string().min(1)).optional(),
  watchdogPolicyId: z.string().min(1).optional(),
  waveformPreview: z
    .object({
      channelCount: z.number().int().positive(),
      generatedAt: isoDateTimeSchema,
      peaks: z.array(z.number().min(0).max(1)).min(1).max(256),
      sampleCount: z.number().int().positive(),
      sampleRate: z.number().int().positive(),
      source: z.enum(["ffmpeg_decoded_peak", "wav_s16le_peak"]),
    })
    .optional(),
});
export const recordingJobChannelMapSchema = z.object({
  assignmentId: z.string().min(1),
  channelMode: channelModeSchema,
  entries: z.array(channelMapEntrySchema).min(1).max(128),
  sourceChannels: z.number().int().positive(),
  targetId: z.string().min(1),
  targetType: templateAssignmentTargetSchema,
  templateId: z.string().min(1),
  templateName: z.string().min(1),
});
export const recordingJobSchema = z.object({
  claimedBy: z.string().min(1).optional(),
  command: z.object({
    captureBackend: audioCaptureBackendSchema.optional(),
    captureChannels: z.number().int().positive(),
    // Resolved 1-based source channels this job owns on the interface. Absent =
    // whole interface (legacy). Drives both the channel map and the controller's
    // per-channel conflict detection.
    captureChannelSelection: captureChannelSelectionSchema.optional(),
    captureDevice: z.string().min(1),
    captureFormat: z.string().min(1),
    // Jobs sharing an interface + capture window carry the same group id so the
    // agent can capture the device once and split it into per-job renditions.
    captureGroupId: z.string().min(1).optional(),
    captureInterfaceId: z.string().min(1).optional(),
    captureSampleRate: z.number().int().positive(),
    channelMap: recordingJobChannelMapSchema.optional(),
    chunkSeconds: z.number().int().positive().optional(),
    durationSeconds: z.number().int().positive(),
    enhancement: recordingEnhancementSchema.optional(),
    outputBitrateKbps: z.number().int().positive().optional(),
    outputCodec: z.enum(["mp3", "flac", "wav"]).optional(),
    outputFileName: z.string().min(1),
    outputVbr: z.boolean().optional(),
    recorderCacheRetention: z
      .object({
        deleteAfterUpload: z.boolean(),
        maxAgeDays: z.number().int().positive().nullable().optional(),
        maxBytes: z.number().int().positive().nullable().optional(),
        minFreeDiskPercent: z.number().int().min(0).max(95).nullable().optional(),
        policyId: z.string().min(1),
      })
      .optional(),
    trackGroupId: z.string().min(1).optional(),
    trackIndex: z.number().int().positive().optional(),
    trackTotal: z.number().int().positive().optional(),
    type: z.literal("alsa_capture"),
  }),
  chunks: z.array(recordingChunkSchema).optional(),
  chunkTotal: z.number().int().positive().optional(),
  completedAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  failureReason: z.string().optional(),
  id: z.string().min(1),
  lastHeartbeatAt: isoDateTimeSchema.optional(),
  leaseExpiresAt: isoDateTimeSchema.optional(),
  nodeId: z.string().min(1),
  recordingId: z.string().min(1),
  startedAt: isoDateTimeSchema.optional(),
  status: recordingJobStatusSchema,
  stopRequestedAt: isoDateTimeSchema.optional(),
});
export const uploadQueueItemSchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  cachePath: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  // Set when this item uploads one recording chunk as its own object. NULL =
  // legacy whole-recording item.
  chunkId: z.string().min(1).optional(),
  chunkIndex: z.number().int().positive().optional(),
  createdAt: isoDateTimeSchema,
  destinationId: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  id: z.string().min(1),
  lastError: z.string().min(1).optional(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: isoDateTimeSchema,
  pathOverride: z.string().min(1).optional(),
  provider: uploadProviderSchema,
  recordingId: z.string().min(1),
  status: uploadQueueStatusSchema,
  target: z.string().min(1).optional(),
  updatedAt: isoDateTimeSchema,
  uploadPolicyId: z.string().min(1).optional(),
});
export const uploadChecksumVerificationSchema = z.object({
  algorithm: z.literal("sha256"),
  expected: z.string().min(1),
  method: z.enum(["file_copy_sha256", "s3_checksum_sha256"]),
  observed: z.string().min(1).optional(),
  // `provider_declared` is the honest status for S3-compatible custom endpoints
  // that may ignore the trailing ChecksumSHA256; only real AWS S3 validates it,
  // which is `provider_validated`. `matched` is our own read-back byte compare.
  status: z.enum(["matched", "provider_validated", "provider_declared"]),
});
export const uploadQueueRunItemSchema = z.object({
  checksumVerification: uploadChecksumVerificationSchema.optional(),
  itemId: z.string().min(1),
  provider: uploadProviderSchema,
  reason: z.string().min(1).optional(),
  recordingId: z.string().min(1),
  status: uploadQueueStatusSchema,
});
export const uploadQueueRunSummarySchema = z.object({
  attempted: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(uploadQueueRunItemSchema),
  succeeded: z.number().int().nonnegative(),
});
export const uploadRunnerStatusSchema = z.object({
  batchSize: z.number().int().positive(),
  intervalSeconds: z.number().int().positive(),
  lastRunAt: isoDateTimeSchema.optional(),
  lastSummary: uploadQueueRunSummarySchema.optional(),
  running: z.boolean(),
  started: z.boolean(),
});

export const uploadPolicyTriggerSchema = z.enum(["manual", "on_recording_cached"]);
export const uploadPolicySchema = z.object({
  deleteCacheAfterUpload: z.boolean().default(false),
  destinationId: z.string().min(1).optional(),
  enabled: z.boolean(),
  id: z.string().min(1),
  maxAttempts: z.number().int().positive().max(100),
  name: z.string().min(1),
  pathOverride: z.string().min(1).max(500).optional(),
  trigger: uploadPolicyTriggerSchema,
  updatedAt: isoDateTimeSchema,
});
export const uploadPolicyInputSchema = z.object({
  deleteCacheAfterUpload: z.boolean().default(false),
  destinationId: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().default(true),
  id: z.string().trim().min(1).max(160).optional(),
  maxAttempts: z.number().int().positive().max(100).default(5),
  name: z.string().trim().min(1).max(160),
  pathOverride: z.string().trim().min(1).max(500).optional(),
  trigger: uploadPolicyTriggerSchema.default("manual"),
});
export const uploadPolicyUpdateSchema = z
  .object({
    deleteCacheAfterUpload: z.boolean().optional(),
    destinationId: z.string().trim().min(1).max(160).optional(),
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().positive().max(100).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    pathOverride: z.string().trim().min(1).max(500).optional(),
    trigger: uploadPolicyTriggerSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one upload policy field is required");

export const retentionPolicyScopeSchema = z.enum(["controller_cache", "recorder_cache"]);
export const retentionPolicyActionSchema = z.enum(["keep", "delete_cache"]);
export const retentionPolicySchema = z.object({
  action: retentionPolicyActionSchema,
  deleteOnlyAfterUploaded: z.boolean(),
  enabled: z.boolean(),
  id: z.string().min(1),
  maxAgeDays: z.number().int().positive().max(3650).nullable(),
  maxBytes: z.number().int().positive().max(1_000_000_000_000_000).nullable(),
  minFreeDiskPercent: z.number().int().min(0).max(95).nullable(),
  name: z.string().min(1),
  preserveTagged: z.boolean(),
  scope: retentionPolicyScopeSchema,
  updatedAt: isoDateTimeSchema,
});
export const retentionPolicyInputSchema = z.object({
  action: retentionPolicyActionSchema.default("keep"),
  deleteOnlyAfterUploaded: z.boolean().default(true),
  enabled: z.boolean().default(true),
  id: z.string().trim().min(1).max(160).optional(),
  maxAgeDays: z.number().int().positive().max(3650).nullable().default(null),
  maxBytes: z.number().int().positive().max(1_000_000_000_000_000).nullable().default(null),
  minFreeDiskPercent: z.number().int().min(0).max(95).nullable().default(null),
  name: z.string().trim().min(1).max(160),
  preserveTagged: z.boolean().default(true),
  scope: retentionPolicyScopeSchema.default("controller_cache"),
});
export const retentionPolicyUpdateSchema = z
  .object({
    action: retentionPolicyActionSchema.optional(),
    deleteOnlyAfterUploaded: z.boolean().optional(),
    enabled: z.boolean().optional(),
    maxAgeDays: z.number().int().positive().max(3650).nullable().optional(),
    maxBytes: z.number().int().positive().max(1_000_000_000_000_000).nullable().optional(),
    minFreeDiskPercent: z.number().int().min(0).max(95).nullable().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    preserveTagged: z.boolean().optional(),
    scope: retentionPolicyScopeSchema.optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one retention policy field is required",
  );

export const healthEventSchema = z.object({
  acknowledgedAt: isoDateTimeSchema.nullable(),
  acknowledgedBy: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
  id: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  openedAt: isoDateTimeSchema,
  recordingId: z.string().optional(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedBy: z.string().optional(),
  scheduleId: z.string().optional(),
  severity: healthSeveritySchema,
  status: healthEventStatusSchema,
  suppressedAt: isoDateTimeSchema.nullable(),
  suppressedBy: z.string().optional(),
  suppressedUntil: isoDateTimeSchema.nullable(),
  type: z.string().min(1),
});

export const defaultStubUploadPolicy = {
  deleteCacheAfterUpload: false,
  enabled: true,
  id: "upload-policy-stub",
  maxAttempts: 5,
  name: "Stub Upload Queue",
  trigger: "manual",
  updatedAt: "1970-01-01T00:00:00.000Z",
} satisfies UploadPolicy;

export const defaultKeepControllerCacheRetentionPolicy = {
  action: "keep",
  deleteOnlyAfterUploaded: true,
  enabled: true,
  id: "retention-keep-controller-cache",
  maxAgeDays: null,
  maxBytes: null,
  minFreeDiskPercent: null,
  name: "Keep Controller Cache",
  preserveTagged: true,
  scope: "controller_cache",
  updatedAt: "1970-01-01T00:00:00.000Z",
} satisfies RetentionPolicy;

export type AudioChannel = z.infer<typeof audioChannelSchema>;
export type ChannelMapAssignmentHistory = z.infer<typeof channelMapAssignmentHistorySchema>;
export type ChannelMapEntry = z.infer<typeof channelMapEntrySchema>;
export type ChannelMapTemplate = z.infer<typeof channelMapTemplateSchema>;
export type ChannelMapTemplateAssignment = z.infer<typeof channelMapTemplateAssignmentSchema>;
export type ChannelMapTemplateAssignmentInput = z.infer<
  typeof channelMapTemplateAssignmentInputSchema
>;
export type ChannelMapTemplateAssignmentBulkInput = z.infer<
  typeof channelMapTemplateAssignmentBulkInputSchema
>;
export type ChannelMapAssignmentPlan = z.infer<typeof channelMapAssignmentPlanSchema>;
export type ChannelMapAssignmentPlanInput = z.infer<typeof channelMapAssignmentPlanInputSchema>;
export type ChannelMapTemplateAssignmentRollbackInput = z.infer<
  typeof channelMapTemplateAssignmentRollbackInputSchema
>;
export type ChannelMapTemplateInput = z.infer<typeof channelMapTemplateInputSchema>;
export type ChannelMapTemplateUpdate = z.infer<typeof channelMapTemplateUpdateSchema>;
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;
export type AudioInterface = z.infer<typeof audioInterfaceSchema>;
export type AccessGroup = z.infer<typeof accessGroupSchema>;
export type AccessGroupId = z.infer<typeof accessGroupIdSchema>;
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export type AccessPolicyEffect = z.infer<typeof accessPolicyEffectSchema>;
export type AccessPolicyInput = z.infer<typeof accessPolicyInputSchema>;
export type AccessPolicySubjectType = z.infer<typeof accessPolicySubjectTypeSchema>;
export type AudioLevel = z.infer<typeof audioLevelSchema>;
export type AudioQuality = z.infer<typeof audioQualitySchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type HealthEvent = z.infer<typeof healthEventSchema>;
export type HealthEventStatus = z.infer<typeof healthEventStatusSchema>;
export type HealthSeverity = z.infer<typeof healthSeveritySchema>;
export type MeterFrame = z.infer<typeof meterFrameSchema>;
export type NodeStatus = z.infer<typeof nodeStatusSchema>;
export type NodeAudioCommandDefaults = z.infer<typeof nodeAudioCommandDefaultsSchema>;
export type NodeRecordingCapacity = z.infer<typeof nodeRecordingCapacitySchema>;
export type NodeRuntime = z.infer<typeof nodeRuntimeSchema>;
export type RecorderNode = z.infer<typeof recorderNodeSchema>;
export type RecordingProfile = z.infer<typeof recordingProfileSchema>;
export type RecordingProfileUpdate = z.infer<typeof recordingProfileUpdateSchema>;
export type ControllerSettings = z.infer<typeof controllerSettingsSchema>;
export type ControllerSettingsUpdate = z.infer<typeof controllerSettingsUpdateSchema>;
export type WeekStartDay = z.infer<typeof weekStartDaySchema>;
export type RecordingJob = z.infer<typeof recordingJobSchema>;
export type RecordingJobChannelMap = z.infer<typeof recordingJobChannelMapSchema>;
export type RecordingJobStatus = z.infer<typeof recordingJobStatusSchema>;
export type RecordingSummary = z.infer<typeof recordingSummarySchema>;
export type RecordingWaveformPreview = NonNullable<RecordingSummary["waveformPreview"]>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RetentionPolicyAction = z.infer<typeof retentionPolicyActionSchema>;
export type RetentionPolicyInput = z.infer<typeof retentionPolicyInputSchema>;
export type RetentionPolicyScope = z.infer<typeof retentionPolicyScopeSchema>;
export type RetentionPolicyUpdate = z.infer<typeof retentionPolicyUpdateSchema>;
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
export type ScheduleCalendarOccurrence = z.infer<typeof scheduleCalendarOccurrenceSchema>;
export type ScheduleCalendarResponse = z.infer<typeof scheduleCalendarResponseSchema>;
export type ScheduleDayOfWeek = z.infer<typeof scheduleDayOfWeekSchema>;
export type ScheduleException = z.infer<typeof scheduleExceptionSchema>;
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export type ScheduleOccurrencePreview = z.infer<typeof scheduleOccurrencePreviewSchema>;
export type ScheduleRecurrenceMode = z.infer<typeof scheduleRecurrenceModeSchema>;
export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;
export type UploadProvider = z.infer<typeof uploadProviderSchema>;
export type UploadPolicy = z.infer<typeof uploadPolicySchema>;
export type UploadPolicyInput = z.infer<typeof uploadPolicyInputSchema>;
export type UploadPolicyTrigger = z.infer<typeof uploadPolicyTriggerSchema>;
export type UploadPolicyUpdate = z.infer<typeof uploadPolicyUpdateSchema>;
export type UploadChecksumVerification = z.infer<typeof uploadChecksumVerificationSchema>;
export type UploadQueueItem = z.infer<typeof uploadQueueItemSchema>;
export type UploadQueueRunItem = z.infer<typeof uploadQueueRunItemSchema>;
export type UploadQueueRunSummary = z.infer<typeof uploadQueueRunSummarySchema>;
export type UploadQueueStatus = z.infer<typeof uploadQueueStatusSchema>;
export type UploadRunnerStatus = z.infer<typeof uploadRunnerStatusSchema>;
