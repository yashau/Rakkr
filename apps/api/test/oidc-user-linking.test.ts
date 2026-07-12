import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createDatabase, createPgliteDatabase, eq, users, type AzureAdOidcClaims } from "@rakkr/db";

const { LocalAuthService } = await import("../src/auth-service.js");
const { normalizeAzureAdOidcUser } = await import("../src/oidc-sync.js");

// Persistence-level linking runs against real Postgres SQL semantics via an
// in-process PGlite (WASM Postgres) database, so it needs no running server.
const pglite = await createPgliteDatabase("oidc-user-linking");

after(() => pglite.close());

function claims(input: Record<string, unknown>): AzureAdOidcClaims {
  return input as AzureAdOidcClaims;
}

test("normalize rejects an explicitly unverified email claim", () => {
  assert.throws(
    () =>
      normalizeAzureAdOidcUser({
        claims: claims({ email: "spoofed@example.com", email_verified: false, sub: "s1" }),
      }),
    /not verified/,
  );
  // A stringified "false" (some IdPs) is rejected too.
  assert.throws(() =>
    normalizeAzureAdOidcUser({
      claims: claims({ email: "spoofed@example.com", email_verified: "false", sub: "s2" }),
    }),
  );
  // Absent (many IdPs omit it) and truthy both pass — linking is subject-keyed.
  assert.doesNotThrow(() =>
    normalizeAzureAdOidcUser({ claims: claims({ email: "ok@example.com", sub: "s3" }) }),
  );
  assert.doesNotThrow(() =>
    normalizeAzureAdOidcUser({
      claims: claims({ email: "ok@example.com", email_verified: true, sub: "s4" }),
    }),
  );
});

test("memory: a login is linked by subject, so a changed email keeps the same account", async () => {
  const auth = new LocalAuthService("");
  const first = await auth.syncAzureAdOidcUser({
    claims: claims({ email: "first@example.com", oid: "subject-stable", sub: "sub-a" }),
  });
  const renamed = await auth.syncAzureAdOidcUser({
    claims: claims({ email: "renamed@example.com", oid: "subject-stable", sub: "sub-a" }),
  });

  assert.equal(first.id, renamed.id);
  assert.equal(renamed.email, "renamed@example.com");
});

test("memory: a second subject may not claim an email already owned by another account", async () => {
  const auth = new LocalAuthService("");
  await auth.syncAzureAdOidcUser({
    claims: claims({ email: "shared@example.com", oid: "subject-one", sub: "one" }),
  });

  await assert.rejects(
    auth.syncAzureAdOidcUser({
      claims: claims({ email: "shared@example.com", oid: "subject-two", sub: "two" }),
    }),
    (error: unknown) => error instanceof Error && /already linked/.test(error.message),
  );
});

test("DB: an OIDC login must NOT take over an existing local account by email (R38-OIDC-EMAIL-LINK)", async () => {
  const db = createDatabase(pglite.url);
  const auth = new LocalAuthService(pglite.url);
  const victimEmail = `linking-victim-${randomUUID()}@example.com`;

  await db
    .insert(users)
    .values({ email: victimEmail, name: "Local Victim", passwordHash: "x", provider: "local" });

  try {
    // A federated login presenting the local user's email but a fresh subject
    // must be REFUSED, never merged onto the local (owner-capable) row.
    await assert.rejects(
      auth.syncAzureAdOidcUser({
        claims: claims({ email: victimEmail, oid: "attacker-subject", sub: "attacker-subject" }),
      }),
      (error: unknown) => error instanceof Error && /already linked/.test(error.message),
    );

    const [row] = await db.select().from(users).where(eq(users.email, victimEmail)).limit(1);
    assert.equal(row?.provider, "local", "victim row must stay local");
    assert.equal(row?.externalId, null, "victim row must not be bound to the federated subject");
  } finally {
    await db.delete(users).where(eq(users.email, victimEmail));
  }
});

test("DB: subject-linking creates one account and re-links it across email changes", async () => {
  const db = createDatabase(pglite.url);
  const auth = new LocalAuthService(pglite.url);
  const subject = `link-subject-${randomUUID()}`;
  const firstEmail = `link-first-${randomUUID()}@example.com`;
  const secondEmail = `link-second-${randomUUID()}@example.com`;

  try {
    const first = await auth.syncAzureAdOidcUser({
      claims: claims({ email: firstEmail, oid: subject, sub: subject }),
    });
    const renamed = await auth.syncAzureAdOidcUser({
      claims: claims({ email: secondEmail, oid: subject, sub: subject }),
    });

    assert.equal(first.id, renamed.id, "same subject must resolve to one account");
    assert.equal(renamed.email, secondEmail);
  } finally {
    await db.delete(users).where(eq(users.email, secondEmail));
    await db.delete(users).where(eq(users.email, firstEmail));
  }
});

test("DB: a legacy email-linked OIDC row (no external_id) is adopted on next login, not duplicated", async () => {
  const db = createDatabase(pglite.url);
  const auth = new LocalAuthService(pglite.url);
  const legacyEmail = `link-legacy-${randomUUID()}@example.com`;
  const subject = `legacy-subject-${randomUUID()}`;

  const [legacy] = await db
    .insert(users)
    .values({ email: legacyEmail, name: "Legacy OIDC", provider: "oidc" })
    .returning({ id: users.id });

  try {
    const user = await auth.syncAzureAdOidcUser({
      claims: claims({ email: legacyEmail, oid: subject, sub: subject }),
    });

    assert.equal(user.id, legacy?.id, "legacy row must be adopted, not duplicated");

    const [row] = await db.select().from(users).where(eq(users.email, legacyEmail)).limit(1);
    assert.equal(row?.externalId, subject, "legacy row must be backfilled with the subject");
  } finally {
    await db.delete(users).where(eq(users.email, legacyEmail));
  }
});
