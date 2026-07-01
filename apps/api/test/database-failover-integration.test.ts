import assert from "node:assert/strict";
import test from "node:test";
import { isDatabaseUnavailableError } from "../src/database-unavailable.js";
import { createRecordingStore } from "../src/recording-store.js";

// Gated: this points a DB-authoritative store at an unreachable Postgres and
// asserts it throws DatabaseUnavailableError (which the API boundary maps to
// 503) instead of silently diverging to the JSON fallback. It opens a
// connection pool, so run it explicitly with `--test-force-exit`; it is skipped
// in the default fallback-store suite.
const enabled = process.env.RAKKR_API_TEST_DB_FAILOVER === "1";

test(
  "a DB-authoritative store throws DatabaseUnavailableError when Postgres is unreachable",
  {
    skip: enabled
      ? false
      : "set RAKKR_API_TEST_DB_FAILOVER=1 (opens a pool; use --test-force-exit)",
  },
  async () => {
    // Unreachable port → connection refused → failover throws instead of
    // returning the boot-time fallback.
    process.env.DATABASE_URL = "postgres://rakkr:rakkr@127.0.0.1:59991/rakkr";
    const store = createRecordingStore([]);

    await assert.rejects(
      () => store.list(),
      (error) => isDatabaseUnavailableError(error),
    );
  },
);
