import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

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
  // Operator-chosen scheduling/ad-hoc defaults; null = no default set (forms
  // fall back to the built-in profile/policy). Nullable, no FK: a referenced
  // policy may be deleted, and the forms tolerate a stale id.
  defaultRecordingProfileId: varchar("default_recording_profile_id", { length: 160 }),
  defaultRetentionPolicyId: varchar("default_retention_policy_id", { length: 160 }),
  defaultUploadPolicyId: varchar("default_upload_policy_id", { length: 160 }),
  defaultWatchdogPolicyId: varchar("default_watchdog_policy_id", { length: 160 }),
  id: varchar("id", { length: 64 }).primaryKey().default("controller"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  weekStartsOn: varchar("week_starts_on", { length: 16 }).notNull().default("monday"),
});

export const watchdogPolicies = pgTable("watchdog_policies", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  id: varchar("id", { length: 160 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  rules: jsonb("rules")
    .notNull()
    .default(sql`'[]'::jsonb`),
});
