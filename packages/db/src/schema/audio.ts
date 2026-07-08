import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { nodes } from "./nodes.js";
import { rooms } from "./rooms.js";

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
    // Room that owns this channel. Room ownership lives at the channel level: any
    // set of a node's channels can belong to a room, and each channel belongs to
    // at most one room. NULL inherits the node default (nodes.room_id). Set null on
    // room delete so hardware rows survive. Preserved across inventory reconcile
    // (matched on interface + channel_index).
    roomId: varchar("room_id", { length: 160 }).references(() => rooms.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    interfaceIdx: index("audio_channels_interface_idx").on(table.interfaceId),
    roomIdx: index("audio_channels_room_idx").on(table.roomId),
  }),
);
