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
]);

export const recordingSourceEnum = pgEnum("recording_source", ["ad_hoc", "schedule"]);

export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "allowed",
  "denied",
  "failed",
  "partial",
  "succeeded",
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
    email: varchar("email", { length: 320 }).notNull().unique(),
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    passwordHash: text("password_hash"),
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

export const nodes = pgTable(
  "nodes",
  {
    agentVersion: varchar("agent_version", { length: 80 }).notNull(),
    alias: varchar("alias", { length: 160 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
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

export const audioInterfaces = pgTable(
  "audio_interfaces",
  {
    alias: varchar("alias", { length: 160 }).notNull(),
    backend: varchar("backend", { length: 40 }).notNull(),
    channelCount: integer("channel_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    sampleRates: jsonb("sample_rates")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  settings: jsonb("settings")
    .notNull()
    .default(sql`'{}'::jsonb`),
  silenceDetectionEnabled: boolean("silence_detection_enabled").notNull().default(false),
  silenceSkipEnabled: boolean("silence_skip_enabled").notNull().default(false),
  vbr: boolean("vbr").notNull().default(true),
});

export const watchdogPolicies = pgTable("watchdog_policies", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  rules: jsonb("rules")
    .notNull()
    .default(sql`'[]'::jsonb`),
});

export const schedules = pgTable(
  "schedules",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    enabled: boolean("enabled").notNull().default(true),
    folderTemplate: text("folder_template").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    nodeId: uuid("node_id").references(() => nodes.id, {
      onDelete: "set null",
    }),
    recurrence: jsonb("recurrence").notNull(),
    recordingProfileId: uuid("recording_profile_id").references(() => recordingProfiles.id, {
      onDelete: "set null",
    }),
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    timezone: varchar("timezone", { length: 80 }).notNull(),
    titleTemplate: text("title_template").notNull(),
    watchdogPolicyId: uuid("watchdog_policy_id").references(() => watchdogPolicies.id, {
      onDelete: "set null",
    }),
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
    folder: text("folder").notNull(),
    healthStatus: varchar("health_status", { length: 32 }).notNull().default("unknown"),
    id: uuid("id").primaryKey().defaultRandom(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    name: text("name").notNull(),
    nodeId: uuid("node_id").references(() => nodes.id, {
      onDelete: "set null",
    }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    scheduleId: uuid("schedule_id").references(() => schedules.id, {
      onDelete: "set null",
    }),
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

export const healthEvents = pgTable(
  "health_events",
  {
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id").references(() => nodes.id, {
      onDelete: "set null",
    }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    recordingId: uuid("recording_id").references(() => recordings.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    scheduleId: uuid("schedule_id").references(() => schedules.id, {
      onDelete: "set null",
    }),
    severity: healthSeverityEnum("severity").notNull(),
    type: varchar("type", { length: 160 }).notNull(),
  },
  (table) => ({
    nodeIdx: index("health_events_node_idx").on(table.nodeId),
    openedAtIdx: index("health_events_opened_at_idx").on(table.openedAt),
    severityIdx: index("health_events_severity_idx").on(table.severity),
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
    permissionId: varchar("permission_id", { length: 120 }).references(() => permissions.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    targetId: varchar("target_id", { length: 160 }),
    targetName: varchar("target_name", { length: 160 }),
    targetType: varchar("target_type", { length: 160 }),
  },
  (table) => ({
    actionIdx: index("audit_events_action_idx").on(table.action),
    actorIdx: index("audit_events_actor_idx").on(table.actorUserId),
    createdAtIdx: index("audit_events_created_at_idx").on(table.createdAt),
    outcomeIdx: index("audit_events_outcome_idx").on(table.outcome),
    permissionIdx: index("audit_events_permission_idx").on(table.permissionId),
    targetIdx: index("audit_events_target_idx").on(table.targetType, table.targetId),
  }),
);
