import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { auditOutcomeEnum } from "./enums.js";

export const auditEvents = pgTable(
  "audit_events",
  {
    action: varchar("action", { length: 160 }).notNull(),
    actorContext: jsonb("actor_context")
      .notNull()
      .default(sql`'{}'::jsonb`),
    actorDisplayName: varchar("actor_display_name", { length: 160 }),
    actorId: varchar("actor_id", { length: 160 }),
    actorRoles: jsonb("actor_roles")
      .notNull()
      .default(sql`'[]'::jsonb`),
    actorType: varchar("actor_type", { length: 40 }).notNull().default("user"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    after: jsonb("after"),
    before: jsonb("before"),
    correlationIds: jsonb("correlation_ids")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    id: uuid("id").primaryKey().defaultRandom(),
    outcome: auditOutcomeEnum("outcome").notNull(),
    permissionId: varchar("permission_id", { length: 120 }),
    reason: text("reason"),
    targetId: varchar("target_id", { length: 160 }),
    targetName: varchar("target_name", { length: 160 }),
    targetType: varchar("target_type", { length: 160 }),
  },
  (table) => ({
    actionIdx: index("audit_events_action_idx").on(table.action),
    actorIdx: index("audit_events_actor_idx").on(table.actorId),
    createdAtIdx: index("audit_events_created_at_idx").on(table.createdAt),
    outcomeIdx: index("audit_events_outcome_idx").on(table.outcome),
    permissionIdx: index("audit_events_permission_idx").on(table.permissionId),
    targetIdx: index("audit_events_target_idx").on(table.targetType, table.targetId),
  }),
);
