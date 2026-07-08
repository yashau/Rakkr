import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { healthSeverityEnum } from "./enums.js";

export const healthEvents = pgTable(
  "health_events",
  {
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: varchar("acknowledged_by", { length: 160 }),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 160 }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    recordingId: varchar("recording_id", { length: 160 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: varchar("resolved_by", { length: 160 }),
    scheduleId: varchar("schedule_id", { length: 160 }),
    severity: healthSeverityEnum("severity").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    suppressedBy: varchar("suppressed_by", { length: 160 }),
    suppressedUntil: timestamp("suppressed_until", { withTimezone: true }),
    type: varchar("type", { length: 160 }).notNull(),
  },
  (table) => ({
    nodeIdx: index("health_events_node_idx").on(table.nodeId),
    openedAtIdx: index("health_events_opened_at_idx").on(table.openedAt),
    severityIdx: index("health_events_severity_idx").on(table.severity),
    statusIdx: index("health_events_status_idx").on(table.status),
  }),
);
