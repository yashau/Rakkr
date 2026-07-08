import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
