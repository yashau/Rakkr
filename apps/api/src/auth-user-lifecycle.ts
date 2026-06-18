import { authSessions, createDatabase, eq, users } from "@rakkr/db";
import type { CurrentUser } from "@rakkr/shared";

import { isUuid } from "./auth-utils.js";
import { hashPassword } from "./password.js";

type AuthDatabase = ReturnType<typeof createDatabase>;

export interface LocalUserRecord {
  disabledAt: Date | null;
  email: string;
  id: string;
  name: string;
  passwordHash: string | null;
  provider: string;
}

export interface AuthSessionLike {
  user: CurrentUser;
}

export const localUserReturning = {
  disabledAt: users.disabledAt,
  email: users.email,
  id: users.id,
  name: users.name,
  passwordHash: users.passwordHash,
  provider: users.provider,
};

export async function resetLocalUserPassword(db: AuthDatabase, userId: string, password: string) {
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

export async function updateLocalUserDisabled(db: AuthDatabase, userId: string, disabled: boolean) {
  const [row] = await db
    .update(users)
    .set({
      disabledAt: disabled ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning(localUserReturning);

  return row;
}

export async function deleteLocalUser(db: AuthDatabase, userId: string) {
  await db.delete(users).where(eq(users.id, userId));
}

export async function revokeUserSessions(
  db: AuthDatabase | undefined,
  sessions: Map<string, AuthSessionLike>,
  userId: string,
) {
  for (const [tokenHash, session] of sessions.entries()) {
    if (session.user.id === userId) {
      sessions.delete(tokenHash);
    }
  }

  if (!db || !isUuid(userId)) {
    return;
  }

  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(eq(authSessions.userId, userId));
}
