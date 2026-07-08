import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./auth.js";

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
