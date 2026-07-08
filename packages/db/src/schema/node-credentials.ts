import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { nodes } from "./nodes.js";

export const nodeCredentials = pgTable(
  "node_credentials",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    nodeId: varchar("node_id", { length: 160 })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: varchar("token_prefix", { length: 48 }).notNull(),
  },
  (table) => ({
    nodeIdx: index("node_credentials_node_idx").on(table.nodeId),
    tokenPrefixIdx: index("node_credentials_token_prefix_idx").on(table.tokenPrefix),
    // At most one un-revoked (active) credential per node — the DB-level guard for
    // the invariant rotateCredential intends (revoke prior, then insert one). The
    // revoke+insert is not atomic on its own, so two concurrent rotations could
    // otherwise both insert an active credential (an un-revoked, still-valid stale
    // token); this partial unique index makes the second insert fail closed.
    activeNodeIdx: uniqueIndex("node_credentials_active_node_idx")
      .on(table.nodeId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export const nodeSshCredentials = pgTable(
  "node_ssh_credentials",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    fingerprint: varchar("fingerprint", { length: 160 }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 160 })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    // SSH private keys must be replayable to authenticate the runner's SSH
    // session, so they are encrypted at rest with the controller master key
    // (AES-256-GCM, see node-ssh-credential-crypto), not hashed.
    privateKeyEncrypted: text("private_key_encrypted").notNull(),
    publicKey: text("public_key").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    username: varchar("username", { length: 64 }).notNull().default("rakkr"),
  },
  (table) => ({
    nodeIdx: index("node_ssh_credentials_node_idx").on(table.nodeId),
    // At most one un-revoked (active) credential per node — the DB-level guard for
    // the "one active key per node" invariant. Revoke-then-insert in persistActive
    // is not atomic on its own, so two concurrent rotations could otherwise both
    // insert an active credential; this partial unique index makes the second
    // insert fail (rolled back with its transaction) instead.
    activeNodeIdx: uniqueIndex("node_ssh_credentials_active_node_idx")
      .on(table.nodeId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export const nodeBootstrapTokens = pgTable(
  "node_bootstrap_tokens",
  {
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: varchar("node_id", { length: 160 })
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    // Single-use, short-TTL bearer presented once at first boot to hand the
    // node-generated SSH key to the controller. Hashed at rest like node tokens.
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: varchar("token_prefix", { length: 48 }).notNull(),
  },
  (table) => ({
    nodeIdx: index("node_bootstrap_tokens_node_idx").on(table.nodeId),
  }),
);
