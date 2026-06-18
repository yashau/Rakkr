import { randomUUID } from "node:crypto";
import { eq, users, type createDatabase } from "@rakkr/db";
import type { CurrentUser } from "@rakkr/shared";

import { localUserReturning, type LocalUserRecord } from "./auth-user-lifecycle.js";
import type { LocalAccess } from "./auth-types.js";
import {
  normalizeAzureAdOidcUser,
  type AzureAdOidcUserSyncInput,
  type NormalizedAzureAdOidcUser,
} from "./oidc-sync.js";

type AuthDatabase = ReturnType<typeof createDatabase>;

export interface OidcUserSyncAdapter {
  currentUserFromRecord: (record: LocalUserRecord) => Promise<CurrentUser>;
  db: () => AuthDatabase | undefined;
  findUserByEmail: (email: string) => Promise<LocalUserRecord | undefined>;
  markDatabaseUnavailable: (error: unknown) => void;
  memoryRecordByEmail: (email: string) => LocalUserRecord | undefined;
  persistAccess: (
    userId: string,
    access: LocalAccess,
    groups: NormalizedAzureAdOidcUser["groups"],
  ) => Promise<void>;
  refreshSessions: (user: CurrentUser) => void;
  saveMemoryRecord: (email: string, record: LocalUserRecord) => void;
}

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
    const existing = await adapter.findUserByEmail(normalized.email);
    const [row] = existing
      ? await db
          .update(users)
          .set({
            email: normalized.email,
            name: normalized.name,
            provider: "oidc",
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id))
          .returning(localUserReturning)
      : await db
          .insert(users)
          .values({
            email: normalized.email,
            name: normalized.name,
            provider: "oidc",
          })
          .returning(localUserReturning);

    if (!row) {
      throw new Error("OIDC user storage returned no record");
    }

    return currentSyncedUser(row, normalized, adapter);
  } catch (error) {
    adapter.markDatabaseUnavailable(error);
    throw error;
  }
}

async function syncMemoryOidcUser(
  normalized: NormalizedAzureAdOidcUser,
  adapter: OidcUserSyncAdapter,
) {
  const existing = adapter.memoryRecordByEmail(normalized.email);
  const record: LocalUserRecord = {
    disabledAt: existing?.disabledAt ?? null,
    email: normalized.email,
    id: existing?.id ?? randomUUID(),
    name: normalized.name,
    passwordHash: existing?.passwordHash ?? null,
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
