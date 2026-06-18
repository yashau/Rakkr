import { z } from "zod";

export const isoDateTimeSchema = z.string().min(1);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const dbfsSchema = z.number().min(-160).max(24);
const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}$/);

export const nodeStatusSchema = z.enum(["online", "offline", "degraded", "recording", "alerting"]);

export const healthSeveritySchema = z.enum(["info", "warning", "critical"]);
export const healthEventStatusSchema = z.enum(["open", "acknowledged", "suppressed", "resolved"]);

export const recordingSourceSchema = z.enum(["ad_hoc", "schedule"]);
export const recordingStatusSchema = z.enum([
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
]);
export const uploadProviderSchema = z.enum(["stub", "smb", "s3"]);
export const uploadProviderStatusSchema = z.enum([
  "disabled",
  "not_configured",
  "not_implemented",
  "ready",
]);
export const uploadQueueStatusSchema = z.enum([
  "queued",
  "retrying",
  "failed",
  "succeeded",
  "cancelled",
]);
export const recordingJobStatusSchema = z.enum([
  "queued",
  "running",
  "stop_requested",
  "cancelled",
  "completed",
  "failed",
]);

export const channelModeSchema = z.enum(["mono", "stereo", "mono_to_stereo_mix", "multichannel"]);
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
  alias: z.string().min(1),
  backend: z.enum(["alsa", "jack", "pipewire", "unknown"]),
  channelCount: z.number().int().nonnegative(),
  channels: z.array(audioChannelSchema),
  id: z.string().min(1),
  sampleRates: z.array(z.number().int().positive()),
  systemName: z.string().min(1),
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
  notes: z.string().optional(),
  status: nodeStatusSchema,
  tags: z.array(z.string().min(1)),
});

export const audioLevelSchema = z.object({
  channelIndex: z.number().int().positive(),
  clipping: z.boolean(),
  label: z.string().min(1),
  peakDbfs: dbfsSchema,
  rmsDbfs: dbfsSchema,
});

export const meterFrameSchema = z.object({
  capturedAt: isoDateTimeSchema,
  interfaceId: z.string().min(1),
  levels: z.array(audioLevelSchema),
  nodeId: z.string().min(1),
});

export const recordingProfileSchema = z.object({
  bitrateKbps: z.number().int().positive(),
  channelMode: channelModeSchema,
  codec: z.enum(["mp3", "flac", "wav"]),
  id: z.string().min(1),
  name: z.string().min(1),
  silenceDetectionEnabled: z.boolean(),
  silenceSkipEnabled: z.boolean(),
  vbr: z.boolean(),
});
export const recordingProfileUpdateSchema = z
  .object({
    bitrateKbps: z.number().int().positive().max(512).optional(),
    channelMode: channelModeSchema.optional(),
    codec: z.enum(["mp3", "flac", "wav"]).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    silenceDetectionEnabled: z.boolean().optional(),
    silenceSkipEnabled: z.boolean().optional(),
    vbr: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one profile field is required");
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

export const watchdogPolicySchema = z.object({
  activeDuring: z.enum(["always", "scheduled_recording", "recording"]),
  graceSeconds: z.number().int().nonnegative(),
  id: z.string().min(1),
  metric: z.enum(["peak", "rms", "percentile_95"]),
  minCumulativeSecondsAboveThreshold: z.number().nonnegative(),
  name: z.string().min(1),
  repeatEverySeconds: z.number().int().positive(),
  severity: healthSeveritySchema,
  thresholdDbfs: dbfsSchema,
  windowSeconds: z.number().int().positive(),
});
export const watchdogPolicyUpdateSchema = z
  .object({
    activeDuring: z.enum(["always", "scheduled_recording", "recording"]).optional(),
    graceSeconds: z.number().int().nonnegative().max(86_400).optional(),
    metric: z.enum(["peak", "rms", "percentile_95"]).optional(),
    minCumulativeSecondsAboveThreshold: z.number().nonnegative().max(86_400).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    repeatEverySeconds: z.number().int().positive().max(86_400).optional(),
    severity: healthSeveritySchema.optional(),
    thresholdDbfs: dbfsSchema.optional(),
    windowSeconds: z.number().int().positive().max(86_400).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one watchdog field is required");

export const scheduleSummarySchema = z.object({
  enabled: z.boolean(),
  folderTemplate: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  nextRunAt: isoDateTimeSchema.optional(),
  nodeId: z.string().min(1),
  recurrence: scheduleRecurrenceSchema.default({ mode: "manual" }),
  recordingProfileId: z.string().min(1),
  room: z.string().min(1),
  tags: z.array(z.string().min(1)),
  timezone: z.string().min(1),
  titleTemplate: z.string().min(1),
  uploadPolicyId: z.string().min(1).default("upload-policy-stub"),
  watchdogPolicyId: z.string().min(1),
});
export const scheduleInputSchema = z.object({
  enabled: z.boolean().default(true),
  folderTemplate: z.string().trim().min(1).max(500),
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160),
  nextRunAt: isoDateTimeSchema.optional(),
  nodeId: z.string().trim().min(1).max(160),
  recurrence: scheduleRecurrenceSchema.optional(),
  recordingProfileId: z.string().trim().min(1).max(160),
  room: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(80)).max(64).default([]),
  timezone: z.string().trim().min(1).max(80),
  titleTemplate: z.string().trim().min(1).max(500),
  uploadPolicyId: z.string().trim().min(1).max(160).default("upload-policy-stub"),
  watchdogPolicyId: z.string().trim().min(1).max(160),
});
export const scheduleUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    folderTemplate: z.string().trim().min(1).max(500).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    nextRunAt: isoDateTimeSchema.optional(),
    nodeId: z.string().trim().min(1).max(160).optional(),
    recurrence: scheduleRecurrenceSchema.optional(),
    recordingProfileId: z.string().trim().min(1).max(160).optional(),
    room: z.string().trim().min(1).max(160).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    titleTemplate: z.string().trim().min(1).max(500).optional(),
    uploadPolicyId: z.string().trim().min(1).max(160).optional(),
    watchdogPolicyId: z.string().trim().min(1).max(160).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one schedule field is required");
export const scheduleOccurrencePreviewSchema = z.object({
  recordingEndAt: isoDateTimeSchema.optional(),
  recordingStartAt: isoDateTimeSchema,
  scheduledStartAt: isoDateTimeSchema.optional(),
});

export const recordingSummarySchema = z.object({
  cached: z.boolean(),
  cachePath: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  durationSeconds: z.number().int().nonnegative(),
  folder: z.string().min(1),
  healthStatus: z.enum(["healthy", "warning", "critical", "unknown"]),
  id: z.string().min(1),
  name: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  recordedAt: isoDateTimeSchema,
  recordingProfileId: z.string().min(1).optional(),
  scheduleId: z.string().min(1).optional(),
  source: recordingSourceSchema,
  status: recordingStatusSchema,
  tags: z.array(z.string().min(1)),
  uploadPolicyId: z.string().min(1).optional(),
  watchdogPolicyId: z.string().min(1).optional(),
  waveformPreview: z
    .object({
      channelCount: z.number().int().positive(),
      generatedAt: isoDateTimeSchema,
      peaks: z.array(z.number().min(0).max(1)).min(1).max(256),
      sampleCount: z.number().int().positive(),
      sampleRate: z.number().int().positive(),
      source: z.literal("wav_s16le_peak"),
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
    captureChannels: z.number().int().positive(),
    captureDevice: z.string().min(1),
    captureFormat: z.string().min(1),
    captureInterfaceId: z.string().min(1).optional(),
    captureSampleRate: z.number().int().positive(),
    channelMap: recordingJobChannelMapSchema.optional(),
    durationSeconds: z.number().int().positive(),
    outputFileName: z.string().min(1),
    type: z.literal("alsa_capture"),
  }),
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
  createdAt: isoDateTimeSchema,
  fileName: z.string().min(1).optional(),
  id: z.string().min(1),
  lastError: z.string().min(1).optional(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: isoDateTimeSchema,
  provider: uploadProviderSchema,
  recordingId: z.string().min(1),
  status: uploadQueueStatusSchema,
  target: z.string().min(1).optional(),
  updatedAt: isoDateTimeSchema,
  uploadPolicyId: z.string().min(1).optional(),
});
export const uploadProviderConfigSchema = z.object({
  credentialRef: z.string().trim().min(1).max(240).optional(),
  displayName: z.string().trim().min(1).max(160),
  enabled: z.boolean(),
  provider: uploadProviderSchema,
  target: z.string().trim().min(1).max(500).optional(),
  updatedAt: isoDateTimeSchema,
});
export const uploadProviderConfigUpdateSchema = uploadProviderConfigSchema
  .omit({ provider: true, updatedAt: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one provider field is required");
export const uploadProviderRuntimeStatusSchema = z.object({
  configured: z.boolean(),
  credentialRef: z.string().optional(),
  displayName: z.string(),
  enabled: z.boolean(),
  implemented: z.boolean(),
  missingFields: z.array(z.string()),
  provider: uploadProviderSchema,
  reason: z.string().optional(),
  requiredFields: z.array(z.string()),
  status: uploadProviderStatusSchema,
  target: z.string().optional(),
  updatedAt: isoDateTimeSchema,
});
export const uploadPolicyTriggerSchema = z.enum(["manual", "on_recording_cached"]);
export const uploadPolicySchema = z.object({
  enabled: z.boolean(),
  id: z.string().min(1),
  maxAttempts: z.number().int().positive().max(100),
  name: z.string().min(1),
  provider: uploadProviderSchema,
  target: z.string().min(1).optional(),
  trigger: uploadPolicyTriggerSchema,
  updatedAt: isoDateTimeSchema,
});
export const uploadPolicyInputSchema = z.object({
  enabled: z.boolean().default(true),
  id: z.string().trim().min(1).max(160).optional(),
  maxAttempts: z.number().int().positive().max(100).default(5),
  name: z.string().trim().min(1).max(160),
  provider: uploadProviderSchema.default("stub"),
  target: z.string().trim().min(1).max(500).optional(),
  trigger: uploadPolicyTriggerSchema.default("manual"),
});
export const uploadPolicyUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().positive().max(100).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    provider: uploadProviderSchema.optional(),
    target: z.string().trim().min(1).max(500).optional(),
    trigger: uploadPolicyTriggerSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one upload policy field is required");

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

export const defaultVoiceRecordingProfile = {
  bitrateKbps: 128,
  channelMode: "mono_to_stereo_mix",
  codec: "mp3",
  id: "voice-mp3-vbr",
  name: "Voice MP3 VBR",
  silenceDetectionEnabled: false,
  silenceSkipEnabled: false,
  vbr: true,
} satisfies RecordingProfile;

export const defaultStubUploadPolicy = {
  enabled: true,
  id: "upload-policy-stub",
  maxAttempts: 5,
  name: "Stub Upload Queue",
  provider: "stub",
  target: "stub://queue-only",
  trigger: "manual",
  updatedAt: "1970-01-01T00:00:00.000Z",
} satisfies UploadPolicy;

export const defaultScheduledVoiceWatchdogPolicy = {
  activeDuring: "scheduled_recording",
  graceSeconds: 300,
  id: "scheduled-voice-watchdog",
  metric: "rms",
  minCumulativeSecondsAboveThreshold: 10,
  name: "Scheduled Voice Watchdog",
  repeatEverySeconds: 900,
  severity: "critical",
  thresholdDbfs: -45,
  windowSeconds: 900,
} satisfies WatchdogPolicy;

export type AudioChannel = z.infer<typeof audioChannelSchema>;
export type ChannelMapAssignmentHistory = z.infer<typeof channelMapAssignmentHistorySchema>;
export type ChannelMapEntry = z.infer<typeof channelMapEntrySchema>;
export type ChannelMapTemplate = z.infer<typeof channelMapTemplateSchema>;
export type ChannelMapTemplateAssignment = z.infer<typeof channelMapTemplateAssignmentSchema>;
export type ChannelMapTemplateAssignmentInput = z.infer<
  typeof channelMapTemplateAssignmentInputSchema
>;
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
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type HealthEvent = z.infer<typeof healthEventSchema>;
export type HealthEventStatus = z.infer<typeof healthEventStatusSchema>;
export type HealthSeverity = z.infer<typeof healthSeveritySchema>;
export type MeterFrame = z.infer<typeof meterFrameSchema>;
export type NodeStatus = z.infer<typeof nodeStatusSchema>;
export type RecorderNode = z.infer<typeof recorderNodeSchema>;
export type RecordingProfile = z.infer<typeof recordingProfileSchema>;
export type RecordingProfileUpdate = z.infer<typeof recordingProfileUpdateSchema>;
export type RecordingJob = z.infer<typeof recordingJobSchema>;
export type RecordingJobChannelMap = z.infer<typeof recordingJobChannelMapSchema>;
export type RecordingJobStatus = z.infer<typeof recordingJobStatusSchema>;
export type RecordingSummary = z.infer<typeof recordingSummarySchema>;
export type RecordingWaveformPreview = NonNullable<RecordingSummary["waveformPreview"]>;
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
export type ScheduleDayOfWeek = z.infer<typeof scheduleDayOfWeekSchema>;
export type ScheduleException = z.infer<typeof scheduleExceptionSchema>;
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export type ScheduleOccurrencePreview = z.infer<typeof scheduleOccurrencePreviewSchema>;
export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;
export type UploadProvider = z.infer<typeof uploadProviderSchema>;
export type UploadProviderConfig = z.infer<typeof uploadProviderConfigSchema>;
export type UploadProviderConfigUpdate = z.infer<typeof uploadProviderConfigUpdateSchema>;
export type UploadProviderRuntimeStatus = z.infer<typeof uploadProviderRuntimeStatusSchema>;
export type UploadProviderStatus = z.infer<typeof uploadProviderStatusSchema>;
export type UploadPolicy = z.infer<typeof uploadPolicySchema>;
export type UploadPolicyInput = z.infer<typeof uploadPolicyInputSchema>;
export type UploadPolicyTrigger = z.infer<typeof uploadPolicyTriggerSchema>;
export type UploadPolicyUpdate = z.infer<typeof uploadPolicyUpdateSchema>;
export type UploadQueueItem = z.infer<typeof uploadQueueItemSchema>;
export type UploadQueueStatus = z.infer<typeof uploadQueueStatusSchema>;
export type WatchdogPolicy = z.infer<typeof watchdogPolicySchema>;
export type WatchdogPolicyUpdate = z.infer<typeof watchdogPolicyUpdateSchema>;
