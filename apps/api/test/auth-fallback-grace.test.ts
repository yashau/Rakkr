import assert from "node:assert/strict";
import test from "node:test";

import { LocalAuthService } from "../src/auth-service.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Points at a closed local port so every DB query fails fast (ECONNREFUSED),
// simulating a DB outage without needing a real server.
const UNREACHABLE_DB_URL = "postgres://rakkr:rakkr@127.0.0.1:1/rakkr";

test("authenticate stops honoring memory-cached sessions after the DB-outage grace", async () => {
  const graceMs = 1000;
  const service = new LocalAuthService(UNREACHABLE_DB_URL, graceMs);
  const adminEmail = process.env.RAKKR_LOCAL_ADMIN_EMAIL ?? "admin@rakkr.local";
  const adminPassword = process.env.RAKKR_LOCAL_ADMIN_PASSWORD ?? "rakkr-local-dev-password";

  // Login falls back to a memory session (the DB writes fail and are swallowed).
  const login = await service.login(adminEmail, adminPassword);

  // Within the grace window the cached session still authenticates.
  const early = await service.authenticate(`Bearer ${login.token}`);
  assert.ok(early.user, "cached session is honored within the fallback grace");

  await delay(graceMs + 200);

  // Past the grace, with the DB still unreachable, the stale session is denied so
  // a revoked user cannot keep access for the whole outage.
  const late = await service.authenticate(`Bearer ${login.token}`);
  assert.equal(late.user, undefined, "cached session is denied once the outage exceeds the grace");
});
