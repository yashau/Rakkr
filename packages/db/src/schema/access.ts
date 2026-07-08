import { index, pgTable, primaryKey, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { accessPolicyEffectEnum, accessPolicySubjectTypeEnum } from "./enums.js";
import { users } from "./auth.js";

export const accessGroups = pgTable("access_groups", {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  description: text("description"),
  id: varchar("id", { length: 120 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userAccessGroups = pgTable(
  "user_access_groups",
  {
    groupId: varchar("group_id", { length: 120 })
      .notNull()
      .references(() => accessGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    groupIdx: index("user_access_groups_group_idx").on(table.groupId),
    pk: primaryKey({ columns: [table.userId, table.groupId] }),
  }),
);

export const accessPolicies = pgTable(
  "access_policies",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    effect: accessPolicyEffectEnum("effect").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    reason: text("reason"),
    resourceId: varchar("resource_id", { length: 160 }).notNull(),
    resourceType: varchar("resource_type", { length: 80 }).notNull(),
    subjectId: varchar("subject_id", { length: 160 }),
    subjectType: accessPolicySubjectTypeEnum("subject_type").notNull(),
  },
  (table) => ({
    resourceIdx: index("access_policies_resource_idx").on(table.resourceType, table.resourceId),
    subjectIdx: index("access_policies_subject_idx").on(table.subjectType, table.subjectId),
  }),
);

export const userResourceGrants = pgTable(
  "user_resource_grants",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resourceId: varchar("resource_id", { length: 160 }).notNull(),
    resourceType: varchar("resource_type", { length: 80 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.resourceType, table.resourceId] }),
    resourceIdx: index("user_resource_grants_resource_idx").on(
      table.resourceType,
      table.resourceId,
    ),
    userIdx: index("user_resource_grants_user_idx").on(table.userId),
  }),
);
