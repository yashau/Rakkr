import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createDatabase, createPgliteDatabase, eq, recordingChunks } from "@rakkr/db";

// Exercises the recording_chunks.size_bytes column width directly (bypassing the
// store's DB->JSON failover, which would otherwise mask a Postgres error). Runs
// against an in-process PGlite (WASM Postgres) database, so it needs no running
// server and is part of the default suite.
const pglite = await createPgliteDatabase("recording-chunk-size-bigint");

after(() => pglite.close());

test("recording chunk size_bytes stores values beyond the 32-bit integer ceiling", async () => {
  const db = createDatabase(pglite.url);
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
});
