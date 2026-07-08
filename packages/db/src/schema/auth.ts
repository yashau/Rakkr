import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const roles = pgTable("roles", {
  description: text("description"),
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
});

export const permissions = pgTable("permissions", {
  description: text("description"),
  id: varchar("id", { length: 120 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    permissionId: varchar("permission_id", { length: 120 })
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    roleId: varchar("role_id", { length: 64 })
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
  }),
);

export const users = pgTable(
  "users",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    email: varchar("email", { length: 320 }).notNull().unique(),
    // Stable federated-identity key (OIDC `oid`/`sub`). Null for local users.
    // OIDC logins link on THIS, not email, so a mutable/unverified email claim
    // can never merge onto another account (see the login-linking invariant).
    externalId: varchar("external_id", { length: 320 }),
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    passwordHash: text("password_hash"),
    provider: varchar("provider", { length: 16 }).notNull().default("local"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index("users_email_idx").on(table.email),
    // Unique per federated subject; Postgres treats NULLs as distinct, so local
    // users (external_id NULL) never collide.
    externalIdIdx: uniqueIndex("users_external_id_idx").on(table.externalId),
  }),
);

export const userRoles = pgTable(
  "user_roles",
  {
    roleId: varchar("role_id", { length: 64 })
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
    roleIdx: index("user_roles_role_idx").on(table.roleId),
  }),
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    ipAddress: varchar("ip_address", { length: 120 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({
    expiresAtIdx: index("auth_sessions_expires_at_idx").on(table.expiresAt),
    tokenHashIdx: index("auth_sessions_token_hash_idx").on(table.tokenHash),
    userIdx: index("auth_sessions_user_idx").on(table.userId),
  }),
);

export const oidcLoginStates = pgTable(
  "oidc_login_states",
  {
    codeVerifier: text("code_verifier").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    nonce: text("nonce").notNull(),
    returnTo: text("return_to"),
    stateHash: text("state_hash").primaryKey(),
  },
  (table) => ({
    expiresAtIdx: index("oidc_login_states_expires_at_idx").on(table.expiresAt),
  }),
);
