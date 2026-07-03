import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

// Exercises the Postgres upload-queue succeed/retry read-modify-write: the clobber
// only appears with real concurrent DB round-trips. Runs only when a test DB is
// provided via RAKKR_API_TEST_DATABASE_URL. DATABASE_URL must be set BEFORE
// importing upload-queue (the module store captures it).
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const {
  enqueueRecordingUpload,
  listUploadQueueItems,
  retryUploadQueueItem,
  startUploadQueueItem,
  succeedUploadQueueItem,
} = await import("../src/upload-queue.js");

test(
  "concurrent upload-queue retry and succeed do not clobber attemptCount",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const ids: string[] = [];

    for (let i = 0; i < 16; i += 1) {
      const item = await enqueueRecordingUpload(recording(), { fileName: "rec.mp3" });

      await startUploadQueueItem(item.id); // attemptCount 0 -> 1, status retrying
      ids.push(item.id);
    }

    // An operator retry() (resets attemptCount to 0 so the runner re-attempts a
    // failed item) races the runner's succeed() (which preserves the attemptCount
    // it read). Pre-fix, a succeed() that read the pre-retry attemptCount writes it
    // back and reverts the operator's reset (last-writer-wins). The per-row lock
    // must serialize the read-modify-write so the reset always survives.
    await Promise.all(ids.flatMap((id) => [retryUploadQueueItem(id), succeedUploadQueueItem(id)]));

    const mine = (await listUploadQueueItems()).filter((item) => ids.includes(item.id));

    assert.equal(mine.length, ids.length, "all queued items must still be present");
    for (const item of mine) {
      assert.equal(
        item.attemptCount,
        0,
        `attemptCount for ${item.id} must be the retry reset (0), not a clobbered stale value`,
      );
    }
  },
);

function recording(): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "unknown",
    id: `rec_uqrace_${randomUUID()}`,
    name: "Upload Race Recording",
    nodeId: `node_${randomUUID()}`,
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: [],
  };
}
