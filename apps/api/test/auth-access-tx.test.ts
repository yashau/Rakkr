import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createDatabase, createPgliteDatabase, eq, userRoles, users } from "@rakkr/db";

// Exercises the access-persistence path against real Postgres SQL semantics via
// an in-process PGlite (WASM Postgres) database, so it needs no running server.
//
// Guards R26-ACCESS-TX: persistLocalUserAccess DELETEs a user's roles/grants/groups
// and then INSERTs the new set. If an INSERT fails (e.g. a role id violating the
// user_roles -> roles FK) after the DELETEs autocommit, the user is left with ALL
// access stripped in the DB while the caller throws. Wrapping the delete+insert
// block in a single transaction must roll the DELETEs back so a failed insert
// leaves the user's PRE-EXISTING access intact.
const pglite = await createPgliteDatabase("auth-access-tx");

after(() => pglite.close());

const { LocalAuthService } = await import("../src/auth-service.js");

test("DB: a failed access INSERT rolls back the DELETEs so prior access survives (R26-ACCESS-TX)", async () => {
  const db = createDatabase(pglite.url);
  const auth = new LocalAuthService(pglite.url);
  const email = `access-tx-${randomUUID()}@example.com`;

  const [row] = await db
    .insert(users)
    .values({ email, name: "Access TX", passwordHash: "x", provider: "local" })
    .returning({ id: users.id });
  const userId = row!.id;

  try {
    // Seed a real, valid role so the user starts with concrete access.
    await auth.updateLocalUserAccess(userId, {
      groupIds: [],
      resourceGrants: [],
      roles: ["operator"],
    });

    const seeded = await db.select().from(userRoles).where(eq(userRoles.userId, userId));
    assert.deepEqual(
      seeded.map((entry) => entry.roleId),
      ["operator"],
      "user must start with the seeded operator role",
    );

    // Drive persistLocalUserAccess with a role id that violates the
    // user_roles -> roles FK. The DELETEs run first; the failing INSERT must
    // roll the whole thing back rather than leave the user stripped.
    await assert.rejects(
      (
        auth as unknown as {
          persistLocalUserAccess: (
            id: string,
            access: { groupIds?: string[]; resourceGrants: never[]; roles: string[] },
            groups: never[],
          ) => Promise<void>;
        }
      ).persistLocalUserAccess(userId, { resourceGrants: [], roles: ["not-a-real-role"] }, []),
    );

    const after = await db.select().from(userRoles).where(eq(userRoles.userId, userId));
    assert.deepEqual(
      after.map((entry) => entry.roleId),
      ["operator"],
      "the failed insert must not strip the user's pre-existing role",
    );
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});
