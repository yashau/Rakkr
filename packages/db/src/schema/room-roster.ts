import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { roomRosterSourceEnum, roomRosterSubjectTypeEnum } from "./enums.js";
import { rooms } from "./rooms.js";
import { schedules } from "./schedules.js";

// Per-room access roster: one row per (room, subject, source[, sourceSchedule]).
// `capabilities` is the independently-toggled per-action set. Effective access
// for a user is the UNION of capabilities across their direct + group rows for a
// room. Uniqueness is enforced in the store (Postgres treats NULL
// sourceScheduleId as distinct, so a DB unique index would not dedupe manual rows).
export const roomRoster = pgTable(
  "room_roster",
  {
    capabilities: jsonb("capabilities")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: varchar("room_id", { length: 160 })
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    source: roomRosterSourceEnum("source").notNull().default("manual"),
    sourceScheduleId: varchar("source_schedule_id", { length: 160 }).references(
      () => schedules.id,
      { onDelete: "cascade" },
    ),
    subjectId: varchar("subject_id", { length: 160 }).notNull(),
    subjectType: roomRosterSubjectTypeEnum("subject_type").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("room_roster_room_idx").on(table.roomId),
    scheduleIdx: index("room_roster_schedule_idx").on(table.sourceScheduleId),
    subjectIdx: index("room_roster_subject_idx").on(table.subjectType, table.subjectId),
  }),
);
