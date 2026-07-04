import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDatabase, eq, users } from "@rakkr/db";

import type { LocalUserRecord } from "../src/auth-user-lifecycle.js";
import type { OidcUserSyncAdapter } from "../src/oidc-user-sync.js";

const { syncAzureAdOidcUser } = await import("../src/oidc-user-sync.js");
const { OidcSyncError } = await import("../src/oidc-sync.js");
const { LocalAuthService } = await import("../src/auth-service.js");

// Guards R39-OIDC-RACE-502.
//
// (a) Two concurrent first-logins of the same NEW subject both INSERT; the loser
//     hits the users_external_id_idx / email unique (23505) and previously surfaced
//     as an opaque 502. The loser must catch 23505 and re-link the winner's row.
// (b) A federated email-swap onto an email another row still holds hits the email
//     unique (23505); it must surface as oidc_email_conflict (403), not 502.
// (c) The memory adapter's email lookup must lowercase its key to match the login
//     path (localUserRecordByEmail), so a mixed-case email resolves the same record.

const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

const subject = "race-subject";
const winnerRow: LocalUserRecord = {
  disabledAt: null,
  email: "winner@example.com",
  externalId: subject,
  id: randomUUID(),
  name: "Race Winner",
  passwordHash: null,
  provider: "oidc",
};

// A fake db whose only exercised operations are the fresh-subject INSERT (made to
// trip 23505) and the writeOidcRow UPDATE (returns the winner row). Everything
// else in the linking path is driven through the stubbed adapter methods.
function raceDb(insertError: unknown) {
  return {
    insert() {
      return {
        values() {
          return {
            returning() {
              return Promise.reject(insertError);
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return Promise.resolve([winnerRow]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as ReturnType<typeof createDatabase>;
}

function stubAdapter(overrides: Partial<OidcUserSyncAdapter>): OidcUserSyncAdapter {
  return {
    currentUserFromRecord: async (record) => ({
      email: record.email,
      groups: [],
      id: record.id,
      name: record.name,
      permissions: [],
      provider: "oidc",
      resourceGrants: [],
      roles: [],
    }),
    db: () => raceDb({ code: "23505" }),
    findUserByEmail: async () => undefined,
    findUserByExternalId: async () => undefined,
    markDatabaseUnavailable: () => undefined,
    memoryRecordByEmail: () => undefined,
    memoryRecordByExternalId: () => undefined,
    persistAccess: async () => undefined,
    refreshSessions: () => undefined,
    saveMemoryRecord: () => undefined,
    ...overrides,
  };
}

test("(a) a concurrent first-login loser (23505) re-links the winner's row, not a 502", async () => {
  let externalIdLookups = 0;
  const adapter = stubAdapter({
    // First lookup (before INSERT) misses; the retry after 23505 finds the winner.
    findUserByExternalId: async () => {
      externalIdLookups += 1;
      return externalIdLookups === 1 ? undefined : winnerRow;
    },
  });

  const user = await syncAzureAdOidcUser(
    { claims: { email: "winner@example.com", oid: subject, sub: subject } },
    adapter,
  );

  assert.equal(externalIdLookups, 2, "the loser must retry the subject lookup after 23505");
  assert.equal(user.id, winnerRow.id, "the loser re-links onto the race winner's row");
});

test("(a) a non-unique INSERT error is not swallowed as a re-link", async () => {
  const adapter = stubAdapter({
    db: () => raceDb({ code: "08006" }), // connection failure, not a unique violation
    findUserByExternalId: async () => undefined,
  });

  await assert.rejects(
    syncAzureAdOidcUser(
      { claims: { email: "winner@example.com", oid: subject, sub: subject } },
      adapter,
    ),
    (error: unknown) => !(error instanceof OidcSyncError),
  );
});

test("(c) the memory email lookup resolves a mixed-case email to the same record", async () => {
  const auth = new LocalAuthService("");

  // Provisioning stores the record under the (lowercased) normalized email key.
  const first = await auth.syncAzureAdOidcUser({
    claims: { email: "Mixed.Case@Example.com", oid: "mixed-subject", sub: "mixed-subject" },
  });

  // The private oidcSyncAdapter's email lookup must match the login path
  // (localUserRecordByEmail), which lowercases — so a mixed-case query resolves the
  // same stored record instead of missing it.
  const adapter = (
    auth as unknown as {
      oidcSyncAdapter: () => {
        memoryRecordByEmail: (email: string) => { id: string } | undefined;
      };
    }
  ).oidcSyncAdapter();

  assert.equal(adapter.memoryRecordByEmail("Mixed.Case@Example.com")?.id, first.id);
  assert.equal(adapter.memoryRecordByEmail("mixed.case@example.com")?.id, first.id);
});

test(
  "(b) DB: a federated email-swap onto an email another subject still holds throws oidc_email_conflict",
  { skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)" },
  async () => {
    const db = createDatabase(dbUrl!);
    const auth = new LocalAuthService(dbUrl);
    const heldEmail = `race-held-${randomUUID()}@example.com`;
    const holderSubject = `race-holder-${randomUUID()}`;
    const moverSubject = `race-mover-${randomUUID()}`;
    const moverEmail = `race-mover-${randomUUID()}@example.com`;

    try {
      // Subject A owns heldEmail.
      await auth.syncAzureAdOidcUser({
        claims: { email: heldEmail, oid: holderSubject, sub: holderSubject },
      });
      // Subject B exists on its own email.
      await auth.syncAzureAdOidcUser({
        claims: { email: moverEmail, oid: moverSubject, sub: moverSubject },
      });

      // Subject B now presents heldEmail (already held by A). The UPDATE trips the
      // email unique (23505) and must surface as a linking conflict, not a 502.
      await assert.rejects(
        auth.syncAzureAdOidcUser({
          claims: { email: heldEmail, oid: moverSubject, sub: moverSubject },
        }),
        (error: unknown) =>
          error instanceof Error && (error as { code?: string }).code === "oidc_email_conflict",
      );
    } finally {
      await db.delete(users).where(eq(users.email, heldEmail));
      await db.delete(users).where(eq(users.email, moverEmail));
    }
  },
);
