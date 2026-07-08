import { index, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

// First-class room. `id` is the stable RBAC scope target (opaque); (site, name)
// is unique so backfill from node locations dedupes and renames don't collide.
export const rooms = pgTable(
  "rooms",
  {
    building: varchar("building", { length: 160 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    description: text("description"),
    floor: varchar("floor", { length: 160 }),
    id: varchar("id", { length: 160 }).primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    notes: text("notes"),
    site: varchar("site", { length: 160 }).notNull().default("Unknown Site"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    siteIdx: index("rooms_site_idx").on(table.site),
    siteNameIdx: uniqueIndex("rooms_site_name_idx").on(table.site, table.name),
  }),
);
