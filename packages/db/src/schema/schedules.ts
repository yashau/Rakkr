import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

import { rooms } from "./rooms.js";

export const schedules = pgTable(
  "schedules",
  {
    // Access-group ids assigned to this schedule. Membership in an assigned
    // group confers scoped RBAC (see the assignment capability bundle in the
    // API) over the schedule's room. Groups are evaluated dynamically.
    assignedGroupIds: jsonb("assigned_group_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // User ids directly assigned to this schedule. Assignment confers scoped
    // RBAC over the schedule's room without changing the user's role.
    assignedUserIds: jsonb("assigned_user_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    // Denormalized room display name/template value; retained for one release.
    // roomId is the source of truth for room identity and RBAC scope.
    room: varchar("room", { length: 160 }).notNull().default("Unknown Room"),
    roomId: varchar("room_id", { length: 160 }).references(() => rooms.id, {
      onDelete: "restrict",
    }),
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
    roomIdx: index("schedules_room_idx").on(table.roomId),
  }),
);
