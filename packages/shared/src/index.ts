import { z } from "zod";

export const isoDateTimeSchema = z.string().min(1);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const dbfsSchema = z.number().min(-160).max(24);

export const nodeStatusSchema = z.enum(["online", "offline", "degraded", "recording", "alerting"]);

export const healthSeveritySchema = z.enum(["info", "warning", "critical"]);

export const recordingSourceSchema = z.enum(["ad_hoc", "schedule"]);
export const recordingStatusSchema = z.enum([
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
]);

export const channelModeSchema = z.enum(["mono", "stereo", "mono_to_stereo_mix", "multichannel"]);

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
export const resourceGrantSchema = z.object({
  resourceId: z.string().min(1),
  resourceType: z.string().min(1),
});

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
  email: z.string().email(),
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

export const scheduleSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nextRunAt: isoDateTimeSchema.optional(),
  nodeId: z.string().min(1),
  room: z.string().min(1),
  tags: z.array(z.string().min(1)),
  timezone: z.string().min(1),
});

export const recordingSummarySchema = z.object({
  cached: z.boolean(),
  durationSeconds: z.number().int().nonnegative(),
  folder: z.string().min(1),
  healthStatus: z.enum(["healthy", "warning", "critical", "unknown"]),
  id: z.string().min(1),
  name: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  recordedAt: isoDateTimeSchema,
  scheduleId: z.string().min(1).optional(),
  source: recordingSourceSchema,
  status: recordingStatusSchema,
  tags: z.array(z.string().min(1)),
});

export const healthEventSchema = z.object({
  details: z.record(z.string(), z.unknown()),
  id: z.string().min(1),
  nodeId: z.string().min(1),
  openedAt: isoDateTimeSchema,
  recordingId: z.string().optional(),
  resolvedAt: isoDateTimeSchema.nullable(),
  scheduleId: z.string().optional(),
  severity: healthSeveritySchema,
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
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;
export type AudioInterface = z.infer<typeof audioInterfaceSchema>;
export type AudioLevel = z.infer<typeof audioLevelSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type HealthEvent = z.infer<typeof healthEventSchema>;
export type HealthSeverity = z.infer<typeof healthSeveritySchema>;
export type MeterFrame = z.infer<typeof meterFrameSchema>;
export type NodeStatus = z.infer<typeof nodeStatusSchema>;
export type RecorderNode = z.infer<typeof recorderNodeSchema>;
export type RecordingProfile = z.infer<typeof recordingProfileSchema>;
export type RecordingSummary = z.infer<typeof recordingSummarySchema>;
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;
export type WatchdogPolicy = z.infer<typeof watchdogPolicySchema>;
