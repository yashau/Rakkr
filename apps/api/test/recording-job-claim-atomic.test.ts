import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

// This test exercises the Postgres claim path specifically: the double-claim
// race only appears with real async DB round-trips (the in-memory store
// serialises read-modify-write within one tick). It runs only when a test DB is
// provided via RAKKR_API_TEST_DATABASE_URL (the repo convention) — otherwise it
// skips and opens no connection pool, so the default fallback-store suite stays
// fast and self-contained. DATABASE_URL must be set BEFORE importing
// recording-jobs (the module captures it at load); Node isolates each test file
// in its own process, so this does not leak into other suites.
//
// In DB mode, run with `--test-force-exit` — the module's pool has no exposed
// close, so the process would otherwise idle until the runner's exit timeout.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const { createRecordingJob, claimRecordingJob } = await import("../src/recording-jobs.js");

test(
  "concurrent claims of the same queued job yield exactly one winner",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const job = await createRecordingJob(recording());

    assert.equal(job.status, "queued");

    // Many agents race to claim the same job at once. Pre-fix (unconditional
    // upsert), several observe `queued` before any write lands and all "win" —
    // multiple agents capturing one job. The atomic compare-and-set guarantees
    // exactly one winner regardless of interleaving. High fan-out makes the race
    // window near-certain to be exercised.
    const claimers = Array.from({ length: 16 }, (_unused, index) =>
      claimRecordingJob(job.id, `agent-${index}`),
    );
    const winners = (await Promise.all(claimers)).filter(Boolean);

    assert.equal(winners.length, 1, "exactly one concurrent claim must win");
    assert.equal(winners[0]?.status, "running");

    // Any later claim, once the job is running, must also lose.
    const late = await claimRecordingJob(job.id, "agent-late");

    assert.equal(late, undefined);
  },
);

function recording(): RecordingSummary {
  const id = `rec_claim_${randomUUID()}`;

  return {
    cached: false,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id,
    name: "Claim Race Recording",
    nodeId: `node_claim_${randomUUID()}`,
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "recording",
    tags: [],
  };
}
