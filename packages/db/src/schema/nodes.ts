import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

import { nodeStatusEnum } from "./enums.js";
import { rooms } from "./rooms.js";

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
    // First-class room this node belongs to (source of truth for room identity;
    // location jsonb is retained for building/floor + legacy display). Operator-
    // set via node management; the agent never sets it.
    roomId: varchar("room_id", { length: 160 }).references(() => rooms.id, {
      onDelete: "set null",
    }),
    status: nodeStatusEnum("status").notNull().default("offline"),
    tags: jsonb("tags")
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    aliasIdx: index("nodes_alias_idx").on(table.alias),
    roomIdx: index("nodes_room_idx").on(table.roomId),
    statusIdx: index("nodes_status_idx").on(table.status),
  }),
);
