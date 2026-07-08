import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { rooms } from "./rooms.js";

// External audio matrix switcher (e.g. AVPro AC-MAX). Non-secret connection
// config is columnar; the optional control-channel password (for models whose
// control channel requires a login) is encrypted at rest in `secrets` via
// secret-box. `model`, `inputs`, and `outputs` are fixed at creation.
// `mode`: disabled (never connect) | observe (compute + audit, never send) |
// enforce (apply routing).
export const switchers = pgTable("switchers", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  displayName: varchar("display_name", { length: 160 }).notNull(),
  enabled: boolean("enabled").notNull().default(false),
  host: varchar("host", { length: 255 }).notNull(),
  id: varchar("id", { length: 160 }).primaryKey(),
  inputs: integer("inputs").notNull(),
  mode: varchar("mode", { length: 16 }).notNull().default("observe"),
  model: varchar("model", { length: 48 }).notNull(),
  outputs: integer("outputs").notNull(),
  port: integer("port").notNull(),
  secrets: jsonb("secrets")
    .notNull()
    .default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  username: varchar("username", { length: 120 }),
});

// Room feed wired to a switcher input jack. One room per input and one input
// per room (per switcher): the composite PK enforces one row per input, the
// room unique index enforces the reverse.
export const switcherInputMap = pgTable(
  "switcher_input_map",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    input: integer("input").notNull(),
    roomId: varchar("room_id", { length: 160 })
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    switcherId: varchar("switcher_id", { length: 160 })
      .notNull()
      .references(() => switchers.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.switcherId, table.input] }),
    roomIdx: index("switcher_input_map_room_idx").on(table.roomId),
    roomUnique: uniqueIndex("switcher_input_map_room_unique").on(table.switcherId, table.roomId),
  }),
);

// Listener desk wired to a switcher output jack. One user per output and one
// output per user (per switcher).
export const switcherOutputMap = pgTable(
  "switcher_output_map",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    output: integer("output").notNull(),
    switcherId: varchar("switcher_id", { length: 160 })
      .notNull()
      .references(() => switchers.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.switcherId, table.output] }),
    userIdx: index("switcher_output_map_user_idx").on(table.userId),
    userUnique: uniqueIndex("switcher_output_map_user_unique").on(table.switcherId, table.userId),
  }),
);
