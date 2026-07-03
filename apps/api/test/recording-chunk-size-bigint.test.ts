import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDatabase, eq, recordingChunks } from "@rakkr/db";

// Exercises the recording_chunks.size_bytes column width directly (bypassing the
// store's DB->JSON failover, which would otherwise mask a Postgres error). Runs
// only when a test DB is provided via RAKKR_API_TEST_DATABASE_URL.
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

test(
  "recording chunk size_bytes stores values beyond the 32-bit integer ceiling",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const db = createDatabase(dbUrl as string);
    const id = `chunk_${randomUUID()}`;
    // > 2^31-1 (2,147,483,647): a single 32-channel WAV chunk overflows a 32-bit
    // column, which threw "integer out of range" and failed the chunk upsert.
    const sizeBytes = 3_000_000_000;

    await db.insert(recordingChunks).values({
      id,
      index: 1,
      jobId: `job_${randomUUID()}`,
      recordingId: `rec_${randomUUID()}`,
      sizeBytes,
      status: "cached",
    });

    const [row] = await db.select().from(recordingChunks).where(eq(recordingChunks.id, id));

    assert.equal(row?.sizeBytes, sizeBytes, "a >2GB chunk size must round-trip, not overflow");
  },
);
