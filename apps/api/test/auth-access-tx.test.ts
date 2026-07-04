import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDatabase, eq, userRoles, users } from "@rakkr/db";

// Exercises the access-persistence path against a real Postgres. Runs only when a
// test DB is provided via RAKKR_API_TEST_DATABASE_URL (repo convention). Run with
// `--test-force-exit` — the db client pool has no exposed close.
//
// Guards R26-ACCESS-TX: persistLocalUserAccess DELETEs a user's roles/grants/groups
// and then INSERTs the new set. If an INSERT fails (e.g. a role id violating the
// user_roles -> roles FK) after the DELETEs autocommit, the user is left with ALL
// access stripped in the DB while the caller throws. Wrapping the delete+insert
// block in a single transaction must roll the DELETEs back so a failed insert
// leaves the user's PRE-EXISTING access intact.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

const { LocalAuthService } = await import("../src/auth-service.js");

test(
  "DB: a failed access INSERT rolls back the DELETEs so prior access survives (R26-ACCESS-TX)",
  { skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)" },
  async () => {
    const db = createDatabase(dbUrl!);
    const auth = new LocalAuthService(dbUrl);
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
  },
);
