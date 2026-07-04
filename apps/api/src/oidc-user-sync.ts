import { randomUUID } from "node:crypto";
import { eq, users, type createDatabase } from "@rakkr/db";
import type { CurrentUser } from "@rakkr/shared";

import { localUserReturning, type LocalUserRecord } from "./auth-user-lifecycle.js";
import type { LocalAccess } from "./auth-types.js";
import {
  normalizeAzureAdOidcUser,
  OidcSyncError,
  type AzureAdOidcUserSyncInput,
  type NormalizedAzureAdOidcUser,
} from "./oidc-sync.js";

type AuthDatabase = ReturnType<typeof createDatabase>;

export interface OidcUserSyncAdapter {
  currentUserFromRecord: (record: LocalUserRecord) => Promise<CurrentUser>;
  db: () => AuthDatabase | undefined;
  findUserByEmail: (email: string) => Promise<LocalUserRecord | undefined>;
  findUserByExternalId: (externalId: string) => Promise<LocalUserRecord | undefined>;
  markDatabaseUnavailable: (error: unknown) => void;
  memoryRecordByEmail: (email: string) => LocalUserRecord | undefined;
  memoryRecordByExternalId: (externalId: string) => LocalUserRecord | undefined;
  persistAccess: (
    userId: string,
    access: LocalAccess,
    groups: NormalizedAzureAdOidcUser["groups"],
  ) => Promise<void>;
  refreshSessions: (user: CurrentUser) => void;
  saveMemoryRecord: (email: string, record: LocalUserRecord) => void;
}

// OIDC identities are keyed on the IdP subject (`externalId` = oid ?? sub), NOT
// email: a mutable/unverified email claim must never let a login merge onto
// another account (e.g. the built-in local admin). Linking rules, in order:
//   1. Known subject -> refresh that account.
//   2. Unknown subject, email owned by a LEGACY email-linked OIDC row (no
//      externalId, created before subject-linking) -> adopt it (backfill subject).
//   3. Unknown subject, email owned by ANY other identity (a local/admin user or
//      a different subject) -> REJECT (`oidc_email_conflict`); never merge.
//   4. Unknown subject, free email -> provision a fresh OIDC account.
export async function syncAzureAdOidcUser(
  input: AzureAdOidcUserSyncInput,
  adapter: OidcUserSyncAdapter,
) {
  const normalized = normalizeAzureAdOidcUser(input);
  const db = adapter.db();

  if (!db) {
    return syncMemoryOidcUser(normalized, adapter);
  }

  try {
    const row = await linkOidcUser(db, normalized, adapter);

    return currentSyncedUser(row, normalized, adapter);
  } catch (error) {
    // A linking conflict is a client/identity error, not a DB outage — surface
    // it as-is so the callback returns 403 rather than latching the store down.
    if (error instanceof OidcSyncError) {
      throw error;
    }

    adapter.markDatabaseUnavailable(error);
    throw error;
  }
}

async function linkOidcUser(
  db: AuthDatabase,
  normalized: NormalizedAzureAdOidcUser,
  adapter: OidcUserSyncAdapter,
) {
  const bySubject = await adapter.findUserByExternalId(normalized.externalId);

  if (bySubject) {
    return writeOidcRow(db, bySubject.id, normalized);
  }

  const byEmail = await adapter.findUserByEmail(normalized.email);

  if (byEmail) {
    if (byEmail.provider === "oidc" && !byEmail.externalId) {
      return writeOidcRow(db, byEmail.id, normalized);
    }

    throw new OidcSyncError(
      "OIDC email is already linked to a different account",
      "oidc_email_conflict",
    );
  }

  const [row] = await db
    .insert(users)
    .values({
      email: normalized.email,
      externalId: normalized.externalId,
      name: normalized.name,
      provider: "oidc",
    })
    .returning(localUserReturning);

  if (!row) {
    throw new Error("OIDC user storage returned no record");
  }

  return row;
}

async function writeOidcRow(
  db: AuthDatabase,
  userId: string,
  normalized: NormalizedAzureAdOidcUser,
) {
  const [row] = await db
    .update(users)
    .set({
      email: normalized.email,
      externalId: normalized.externalId,
      name: normalized.name,
      provider: "oidc",
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning(localUserReturning);

  if (!row) {
    throw new Error("OIDC user storage returned no record");
  }

  return row;
}

async function syncMemoryOidcUser(
  normalized: NormalizedAzureAdOidcUser,
  adapter: OidcUserSyncAdapter,
) {
  const bySubject = adapter.memoryRecordByExternalId(normalized.externalId);

  if (bySubject) {
    return saveMemoryOidcRecord(bySubject, normalized, adapter);
  }

  const byEmail = adapter.memoryRecordByEmail(normalized.email);

  if (byEmail) {
    if (byEmail.provider === "oidc" && !byEmail.externalId) {
      return saveMemoryOidcRecord(byEmail, normalized, adapter);
    }

    throw new OidcSyncError(
      "OIDC email is already linked to a different account",
      "oidc_email_conflict",
    );
  }

  return saveMemoryOidcRecord(
    {
      disabledAt: null,
      email: normalized.email,
      externalId: null,
      id: randomUUID(),
      name: normalized.name,
      passwordHash: null,
      provider: "oidc",
    },
    normalized,
    adapter,
  );
}

async function saveMemoryOidcRecord(
  base: LocalUserRecord,
  normalized: NormalizedAzureAdOidcUser,
  adapter: OidcUserSyncAdapter,
) {
  const record: LocalUserRecord = {
    ...base,
    email: normalized.email,
    externalId: normalized.externalId,
    name: normalized.name,
    provider: "oidc",
  };

  adapter.saveMemoryRecord(normalized.email, record);

  return currentSyncedUser(record, normalized, adapter);
}

async function currentSyncedUser(
  record: LocalUserRecord,
  normalized: NormalizedAzureAdOidcUser,
  adapter: OidcUserSyncAdapter,
) {
  await adapter.persistAccess(record.id, normalized, normalized.groups);

  const user = await adapter.currentUserFromRecord(record);

  adapter.refreshSessions(user);

  return user;
}
