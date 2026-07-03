import assert from "node:assert/strict";
import test from "node:test";

// Exercises the login persistence path against a real Postgres. Runs only when a
// test DB is provided via RAKKR_API_TEST_DATABASE_URL. DATABASE_URL must be set
// BEFORE importing the auth service. Run with `--test-force-exit` — the db client
// pool has no exposed close.
//
// Guards the R8-DBLATCH scoping fix: a data-integrity error (SQLSTATE class 22/23)
// on the fire-and-forget login-session persistence must NOT abort the login. The
// authSessions.ip_address column is varchar(120); a login carrying a longer
// X-Forwarded-For (a real multi-hop proxy chain) trips 22001
// (string_data_right_truncation) on the session INSERT. Pre-fix,
// markDatabaseUnavailable re-threw the constraint error, so a valid credential
// login surfaced as 401. It must degrade: the session lives in memory, the login
// still returns a token.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

process.env.RAKKR_LOCAL_ADMIN_EMAIL = "admin@rakkr.local";
process.env.RAKKR_LOCAL_ADMIN_PASSWORD = "rakkr-login-constraint-password";

const { LocalAuthService } = await import("../src/auth-service.js");

test(
  "a valid login is not aborted by an over-long session ip_address (constraint error is not re-thrown)",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const service = new LocalAuthService(dbUrl);

    // A realistic long forwarded-for chain: well past the varchar(120) budget.
    const longForwardedFor = Array.from({ length: 12 }, (_, index) => `203.0.113.${index}`).join(
      ", ",
    );
    assert.ok(
      longForwardedFor.length > 120,
      "the forwarded-for chain must exceed the column budget",
    );

    const result = await service.login("admin@rakkr.local", "rakkr-login-constraint-password", {
      ipAddress: longForwardedFor,
    });

    assert.ok(result.token, "login returns a session token despite the failed session persist");
    assert.equal(result.user.email, "admin@rakkr.local");

    // The session must still authenticate (served from the in-memory fallback).
    const authed = await service.authenticate(`Bearer ${result.token}`);
    assert.equal(authed.user?.email, "admin@rakkr.local");
  },
);
