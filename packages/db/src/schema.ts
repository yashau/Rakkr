import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const nodeStatusEnum = pgEnum("node_status", [
  "online",
  "offline",
  "degraded",
  "recording",
  "alerting",
]);

export const healthSeverityEnum = pgEnum("health_severity", ["info", "warning", "critical"]);

export const recordingStatusEnum = pgEnum("recording_status", [
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
  "partial",
]);
export const recordingJobStatusEnum = pgEnum("recording_job_status", [
  "queued",
  "running",
  "stop_requested",
  "cancelled",
  "completed",
  "failed",
]);
export const recordingChunkStatusEnum = pgEnum("recording_chunk_status", [
  "capturing",
  "cached",
  "uploading",
  "uploaded",
  "partial",
  "failed",
]);

export const recordingSourceEnum = pgEnum("recording_source", ["ad_hoc", "schedule"]);

export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "allowed",
  "denied",
  "failed",
  "partial",
  "succeeded",
]);
export const accessPolicyEffectEnum = pgEnum("access_policy_effect", ["allow", "deny"]);
export const accessPolicySubjectTypeEnum = pgEnum("access_policy_subject_type", [
  "user",
  "group",
  "everyone",
]);

export const roles = pgTable("roles", {
  description: text("description"),
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
});

export const permissions = pgTable("permissions", {
  description: text("description"),
  id: varchar("id", { length: 120 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    permissionId: varchar("permission_id", { length: 120 })
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    roleId: varchar("role_id", { length: 64 })
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
  }),
);

export const users = pgTable(
  "users",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    email: varchar("email", { length: 320 }).notNull().unique(),
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    passwordHash: text("password_hash"),
    provider: varchar("provider", { length: 16 }).notNull().default("local"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index("users_email_idx").on(table.email),
  }),
);

export const userRoles = pgTable(
  "user_roles",
  {
    roleId: varchar("role_id", { length: 64 })
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
    roleIdx: index("user_roles_role_idx").on(table.roleId),
  }),
);

export const accessGroups = pgTable("access_groups", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  description: text("description"),
  id: varchar("id", { length: 120 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userAccessGroups = pgTable(
  "user_access_groups",
  {
    groupId: varchar("group_id", { length: 120 })
      .notNull()
      .references(() => accessGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    groupIdx: index("user_access_groups_group_idx").on(table.groupId),
    pk: primaryKey({ columns: [table.userId, table.groupId] }),
  }),
);

export const accessPolicies = pgTable(
  "access_policies",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    effect: accessPolicyEffectEnum("effect").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    reason: text("reason"),
    resourceId: varchar("resource_id", { length: 160 }).notNull(),
    resourceType: varchar("resource_type", { length: 80 }).notNull(),
    subjectId: varchar("subject_id", { length: 160 }),
    subjectType: accessPolicySubjectTypeEnum("subject_type").notNull(),
  },
  (table) => ({
    resourceIdx: index("access_policies_resource_idx").on(table.resourceType, table.resourceId),
    subjectIdx: index("access_policies_subject_idx").on(table.subjectType, table.subjectId),
  }),
);

export const userResourceGrants = pgTable(
  "user_resource_grants",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resourceId: varchar("resource_id", { length: 160 }).notNull(),
    resourceType: varchar("resource_type", { length: 80 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.resourceType, table.resourceId] }),
    resourceIdx: index("user_resource_grants_resource_idx").on(
      table.resourceType,
      table.resourceId,
    ),
    userIdx: index("user_resource_grants_user_idx").on(table.userId),
  }),
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    ipAddress: varchar("ip_address", { length: 120 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    expiresAtIdx: index("auth_sessions_expires_at_idx").on(table.expiresAt),
    tokenHashIdx: index("auth_sessions_token_hash_idx").on(table.tokenHash),
    userIdx: index("auth_sessions_user_idx").on(table.userId),
  }),
);

export const oidcLoginStates = pgTable(
  "oidc_login_states",
  {
    codeVerifier: text("code_verifier").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    nonce: text("nonce").notNull(),
    returnTo: text("return_to"),
    stateHash: text("state_hash").primaryKey(),
  },
  (table) => ({
    expiresAtIdx: index("oidc_login_states_expires_at_idx").on(table.expiresAt),
  }),
);

export const nodes = pgTable(
  "nodes",
  {
    agentVersion: varchar("agent_version", { length: 80 }).notNull(),
    alias: varchar("alias", { length: 160 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    id: varchar("id", { length: 160 }).primaryKey(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    location: jsonb("location")
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    network: jsonb("network")
      .notNull()
      .default(sql`'{}'::jsonb`),
    notes: text("notes"),
    status: nodeStatusEnum("status").notNull().default("offline"),
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    aliasIdx: index("nodes_alias_idx").on(table.alias),
    statusIdx: index("nodes_status_idx").on(table.status),
  }),
);

export const nodeCredentials = pgTable(
  "node_credentials",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    nodeId: varchar("node_id", { length: 160 })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: varchar("token_prefix", { length: 48 }).notNull(),
  },
  (table) => ({
    nodeIdx: index("node_credentials_node_idx").on(table.nodeId),
    tokenPrefixIdx: index("node_credentials_token_prefix_idx").on(table.tokenPrefix),
  }),
);

export const nodeSshCredentials = pgTable(
  "node_ssh_credentials",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    fingerprint: varchar("fingerprint", { length: 160 }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 160 })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    // SSH private keys must be replayable to authenticate the runner's SSH
    // session, so they are encrypted at rest with the controller master key
    // (AES-256-GCM, see node-ssh-credential-crypto), not hashed.
    privateKeyEncrypted: text("private_key_encrypted").notNull(),
    publicKey: text("public_key").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    username: varchar("username", { length: 64 }).notNull().default("rakkr"),
  },
  (table) => ({
    nodeIdx: index("node_ssh_credentials_node_idx").on(table.nodeId),
  }),
);

export const nodeBootstrapTokens = pgTable(
  "node_bootstrap_tokens",
  {
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 160 })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    // Single-use, short-TTL bearer presented once at first boot to hand the
    // node-generated SSH key to the controller. Hashed at rest like node tokens.
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: varchar("token_prefix", { length: 48 }).notNull(),
  },
  (table) => ({
    nodeIdx: index("node_bootstrap_tokens_node_idx").on(table.nodeId),
  }),
);

export const audioInterfaces = pgTable(
  "audio_interfaces",
  {
    // Set when the agent's startup inventory reconcile no longer reports this
    // interface. Absent interfaces are flagged (preserving channel-map history)
    // rather than hard-deleted; cleared when the device is reported again.
    absentAt: timestamp("absent_at", { withTimezone: true }),
    alias: varchar("alias", { length: 160 }).notNull(),
    backend: varchar("backend", { length: 40 }).notNull(),
    channelCount: integer("channel_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    hardwarePath: varchar("hardware_path", { length: 500 }),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 160 })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    sampleRates: jsonb("sample_rates")
      .notNull()
      .default(sql`'[]'::jsonb`),
    serialNumber: varchar("serial_number", { length: 255 }),
    systemName: varchar("system_name", { length: 255 }).notNull(),
    systemRef: varchar("system_ref", { length: 255 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nodeIdx: index("audio_interfaces_node_idx").on(table.nodeId),
  }),
);

export const audioChannels = pgTable(
  "audio_channels",
  {
    alias: varchar("alias", { length: 160 }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    index: integer("channel_index").notNull(),
    interfaceId: uuid("interface_id")
      .notNull()
      .references(() => audioInterfaces.id, { onDelete: "cascade" }),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => ({
    interfaceIdx: index("audio_channels_interface_idx").on(table.interfaceId),
  }),
);

export const recordingProfiles = pgTable("recording_profiles", {
  bitrateKbps: integer("bitrate_kbps").notNull(),
  channelMode: varchar("channel_mode", { length: 64 }).notNull(),
  codec: varchar("codec", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  id: varchar("id", { length: 160 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  settings: jsonb("settings")
    .notNull()
    .default(sql`'{}'::jsonb`),
  silenceDetectionEnabled: boolean("silence_detection_enabled").notNull().default(false),
  silenceSkipEnabled: boolean("silence_skip_enabled").notNull().default(false),
  vbr: boolean("vbr").notNull().default(true),
});

export const controllerSettings = pgTable("controller_settings", {
  controllerName: varchar("controller_name", { length: 160 }).notNull().default("Rakkr Controller"),
  id: varchar("id", { length: 64 }).primaryKey().default("controller"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const watchdogPolicies = pgTable("watchdog_policies", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  id: varchar("id", { length: 160 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  rules: jsonb("rules")
    .notNull()
    .default(sql`'[]'::jsonb`),
});

export const channelMapTemplates = pgTable("channel_map_templates", {
  channelMode: varchar("channel_mode", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  entries: jsonb("entries")
    .notNull()
    .default(sql`'[]'::jsonb`),
  id: varchar("id", { length: 160 }).primaryKey(),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  name: varchar("name", { length: 160 }).notNull(),
  tags: jsonb("tags")
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const templateAssignments = pgTable(
  "template_assignments",
  {
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    targetId: varchar("target_id", { length: 160 }).notNull(),
    targetType: varchar("target_type", { length: 40 }).notNull(),
    templateId: varchar("template_id", { length: 160 }).notNull(),
    templateKind: varchar("template_kind", { length: 80 }).notNull(),
  },
  (table) => ({
    targetIdx: index("template_assignments_target_idx").on(
      table.templateKind,
      table.targetType,
      table.targetId,
    ),
    templateIdx: index("template_assignments_template_idx").on(
      table.templateKind,
      table.templateId,
    ),
  }),
);

export const uploadProviders = pgTable("upload_providers", {
  // Non-secret typed connection config (smb/s3 fields).
  config: jsonb("config")
    .notNull()
    .default(sql`'{}'::jsonb`),
  displayName: varchar("display_name", { length: 160 }).notNull(),
  enabled: boolean("enabled").notNull().default(false),
  provider: varchar("provider", { length: 32 }).primaryKey(),
  // Encrypted secret material (smbPassword, s3SecretAccessKey).
  secrets: jsonb("secrets")
    .notNull()
    .default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Named SMB/S3 upload targets. Unlike upload_providers (one row per kind), many
// destinations of each kind may exist; upload policies reference one by id.
export const uploadDestinations = pgTable("upload_destinations", {
  // Non-secret typed connection config (smb/s3 fields).
  config: jsonb("config")
    .notNull()
    .default(sql`'{}'::jsonb`),
  displayName: varchar("display_name", { length: 160 }).notNull(),
  enabled: boolean("enabled").notNull().default(false),
  id: varchar("id", { length: 160 }).primaryKey(),
  kind: varchar("kind", { length: 32 }).notNull(),
  // Encrypted secret material (smbPassword, s3SecretAccessKey).
  secrets: jsonb("secrets")
    .notNull()
    .default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const uploadPolicies = pgTable("upload_policies", {
  deleteCacheAfterUpload: boolean("delete_cache_after_upload").notNull().default(false),
  destinationId: varchar("destination_id", { length: 160 }),
  enabled: boolean("enabled").notNull().default(false),
  id: varchar("id", { length: 160 }).primaryKey(),
  maxAttempts: integer("max_attempts").notNull().default(5),
  name: varchar("name", { length: 160 }).notNull(),
  pathOverride: text("path_override"),
  // Legacy columns superseded by destinationId/pathOverride; retained nullable for
  // backfill and dropped in a later migration.
  provider: varchar("provider", { length: 32 }),
  target: text("target"),
  trigger: varchar("trigger", { length: 40 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const uploadQueueItems = pgTable(
  "upload_queue_items",
  {
    attemptCount: integer("attempt_count").notNull().default(0),
    cachePath: text("cache_path"),
    checksum: varchar("checksum", { length: 160 }),
    // Chunk this upload item belongs to. NULL = legacy whole-recording item.
    chunkId: varchar("chunk_id", { length: 160 }),
    chunkIndex: integer("chunk_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    destinationId: varchar("destination_id", { length: 160 }),
    fileName: text("file_name").notNull(),
    id: varchar("id", { length: 160 }).primaryKey(),
    lastError: text("last_error"),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    pathOverride: text("path_override"),
    provider: varchar("provider", { length: 32 }).notNull(),
    recordingId: varchar("recording_id", { length: 160 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    target: text("target"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    uploadPolicyId: varchar("upload_policy_id", { length: 160 }),
  },
  (table) => ({
    chunkIdx: index("upload_queue_items_chunk_idx").on(table.chunkId),
    destinationStatusIdx: index("upload_queue_items_destination_status_idx").on(
      table.destinationId,
      table.status,
    ),
    dueIdx: index("upload_queue_items_due_idx").on(table.status, table.nextAttemptAt),
    providerStatusIdx: index("upload_queue_items_provider_status_idx").on(
      table.provider,
      table.status,
    ),
    recordingIdx: index("upload_queue_items_recording_idx").on(table.recordingId),
  }),
);

export const schedules = pgTable(
  "schedules",
  {
    captureBackend: varchar("capture_backend", { length: 32 }),
    // Ordered 1-based source channel indices selected from the capture
    // interface. Empty array = capture the whole interface (legacy behavior).
    captureChannelSelection: jsonb("capture_channel_selection")
      .notNull()
      .default(sql`'[]'::jsonb`),
    captureInterfaceId: varchar("capture_interface_id", { length: 160 }),
    // Output mode applied to the selected channels (mono/stereo/etc).
    channelMode: varchar("channel_mode", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    enabled: boolean("enabled").notNull().default(true),
    folderTemplate: text("folder_template").notNull(),
    id: varchar("id", { length: 160 }).primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    nodeId: varchar("node_id", { length: 160 }),
    recurrence: jsonb("recurrence").notNull(),
    recordingProfileId: varchar("recording_profile_id", { length: 160 }),
    retentionPolicyId: varchar("retention_policy_id", { length: 160 }),
    room: varchar("room", { length: 160 }).notNull().default("Unknown Room"),
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    timezone: varchar("timezone", { length: 80 }).notNull(),
    titleTemplate: text("title_template").notNull(),
    // Legacy single-policy column superseded by uploadPolicyIds; retained nullable
    // for backfill and dropped in a later migration.
    uploadPolicyId: varchar("upload_policy_id", { length: 160 }),
    uploadPolicyIds: jsonb("upload_policy_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    watchdogPolicyId: varchar("watchdog_policy_id", { length: 160 }),
  },
  (table) => ({
    enabledIdx: index("schedules_enabled_idx").on(table.enabled),
    nodeIdx: index("schedules_node_idx").on(table.nodeId),
  }),
);

export const recordings = pgTable(
  "recordings",
  {
    cachePath: text("cache_path"),
    checksum: varchar("checksum", { length: 160 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    // Voice-enhancement renditions. `cachePath` stays the default-playback file;
    // `rawCachePath`/`enhancedCachePath` are set when both renditions exist so the
    // player and live monitor can switch between raw and enhanced audio.
    enhancedCachePath: text("enhanced_cache_path"),
    folder: text("folder").notNull(),
    rawCachePath: text("raw_cache_path"),
    healthStatus: varchar("health_status", { length: 32 }).notNull().default("unknown"),
    id: varchar("id", { length: 160 }).primaryKey(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    name: text("name").notNull(),
    nodeId: varchar("node_id", { length: 160 }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    scheduleId: varchar("schedule_id", { length: 160 }),
    source: recordingSourceEnum("source").notNull(),
    status: recordingStatusEnum("status").notNull(),
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => ({
    recordedAtIdx: index("recordings_recorded_at_idx").on(table.recordedAt),
    scheduleIdx: index("recordings_schedule_idx").on(table.scheduleId),
    statusIdx: index("recordings_status_idx").on(table.status),
  }),
);

export const recordingJobs = pgTable(
  "recording_jobs",
  {
    claimedBy: varchar("claimed_by", { length: 160 }),
    command: jsonb("command").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    failureReason: text("failure_reason"),
    id: varchar("id", { length: 120 }).primaryKey(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nodeId: varchar("node_id", { length: 160 }).notNull(),
    recordingId: varchar("recording_id", { length: 160 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: recordingJobStatusEnum("status").notNull(),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    leaseIdx: index("recording_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
    nodeStatusIdx: index("recording_jobs_node_status_idx").on(table.nodeId, table.status),
    recordingIdx: index("recording_jobs_recording_idx").on(table.recordingId),
  }),
);

// One time-based segment of a recording. Many chunks belong to one recording +
// one job (`recordingId`/`jobId`); `index` is 1-based and `total` is filled in
// only once capture stops. Each chunk renders raw + enhanced and uploads as it
// closes, then fans out to its own per-destination upload_queue_items.
export const recordingChunks = pgTable(
  "recording_chunks",
  {
    cachedAt: timestamp("cached_at", { withTimezone: true }),
    cachePath: text("cache_path"),
    checksum: varchar("checksum", { length: 160 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    enhancedCachePath: text("enhanced_cache_path"),
    id: varchar("id", { length: 160 }).primaryKey(),
    index: integer("index").notNull(),
    jobId: varchar("job_id", { length: 160 }).notNull(),
    offsetSeconds: integer("offset_seconds").notNull().default(0),
    rawCachePath: text("raw_cache_path"),
    recordingId: varchar("recording_id", { length: 160 }).notNull(),
    sizeBytes: integer("size_bytes"),
    status: recordingChunkStatusEnum("status").notNull(),
    total: integer("total"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdx: index("recording_chunks_job_idx").on(table.jobId),
    recordingIdx: index("recording_chunks_recording_idx").on(table.recordingId),
    recordingIndexUnique: uniqueIndex("recording_chunks_recording_index_unique").on(
      table.recordingId,
      table.index,
    ),
  }),
);

export const healthEvents = pgTable(
  "health_events",
  {
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: varchar("acknowledged_by", { length: 160 }),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 160 }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    recordingId: varchar("recording_id", { length: 160 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: varchar("resolved_by", { length: 160 }),
    scheduleId: varchar("schedule_id", { length: 160 }),
    severity: healthSeverityEnum("severity").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    suppressedBy: varchar("suppressed_by", { length: 160 }),
    suppressedUntil: timestamp("suppressed_until", { withTimezone: true }),
    type: varchar("type", { length: 160 }).notNull(),
  },
  (table) => ({
    nodeIdx: index("health_events_node_idx").on(table.nodeId),
    openedAtIdx: index("health_events_opened_at_idx").on(table.openedAt),
    severityIdx: index("health_events_severity_idx").on(table.severity),
    statusIdx: index("health_events_status_idx").on(table.status),
  }),
);

export const auditEvents = pgTable(
  "audit_events",
  {
    action: varchar("action", { length: 160 }).notNull(),
    actorContext: jsonb("actor_context")
      .notNull()
      .default(sql`'{}'::jsonb`),
    actorDisplayName: varchar("actor_display_name", { length: 160 }),
    actorId: varchar("actor_id", { length: 160 }),
    actorRoles: jsonb("actor_roles")
      .notNull()
      .default(sql`'[]'::jsonb`),
    actorType: varchar("actor_type", { length: 40 }).notNull().default("user"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    after: jsonb("after"),
    before: jsonb("before"),
    correlationIds: jsonb("correlation_ids")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    id: uuid("id").primaryKey().defaultRandom(),
    outcome: auditOutcomeEnum("outcome").notNull(),
    permissionId: varchar("permission_id", { length: 120 }),
    reason: text("reason"),
    targetId: varchar("target_id", { length: 160 }),
    targetName: varchar("target_name", { length: 160 }),
    targetType: varchar("target_type", { length: 160 }),
  },
  (table) => ({
    actionIdx: index("audit_events_action_idx").on(table.action),
    actorIdx: index("audit_events_actor_idx").on(table.actorId),
    createdAtIdx: index("audit_events_created_at_idx").on(table.createdAt),
    outcomeIdx: index("audit_events_outcome_idx").on(table.outcome),
    permissionIdx: index("audit_events_permission_idx").on(table.permissionId),
    targetIdx: index("audit_events_target_idx").on(table.targetType, table.targetId),
  }),
);
