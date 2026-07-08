import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import {
  recordingChunkStatusEnum,
  recordingJobStatusEnum,
  recordingSourceEnum,
  recordingStatusEnum,
} from "./enums.js";
import { rooms } from "./rooms.js";

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
    // Room that owns this recording, captured at create time from the room of the
    // selected channels. Persisted (not derived) so a later channel reassignment
    // never retroactively moves a completed recording or its RBAC visibility.
    roomId: varchar("room_id", { length: 160 }).references(() => rooms.id, {
      onDelete: "set null",
    }),
    scheduleId: varchar("schedule_id", { length: 160 }),
    source: recordingSourceEnum("source").notNull(),
    status: recordingStatusEnum("status").notNull(),
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => ({
    recordedAtIdx: index("recordings_recorded_at_idx").on(table.recordedAt),
    roomIdx: index("recordings_room_idx").on(table.roomId),
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
    // A single chunk of multichannel/uncompressed audio (e.g. 32-ch X32 WAV) can
    // exceed the 2 GiB signed-int32 ceiling, which threw "integer out of range" on
    // upsert and failed the chunk. bigint (JS number, exact to 2^53 = 8 PiB) holds it.
    sizeBytes: bigint("size_bytes", { mode: "number" }),
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
