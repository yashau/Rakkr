import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

import { filterRecordings } from "../src/recording-listing.js";

test("recording listing filters cached and missing cache states", () => {
  const recordings = [
    recording({ cachePath: "cached/flagged.mp3", cached: true, id: "rec_cached_flagged" }),
    recording({ cachePath: "cached/status.mp3", id: "rec_cached_status", status: "cached" }),
    recording({ cachePath: "uploaded/status.mp3", id: "rec_uploaded_status", status: "uploaded" }),
    recording({ cachePath: undefined, id: "rec_missing_path" }),
    recording({ cachePath: "active/raw.wav", id: "rec_active", status: "recording" }),
  ];

  assert.deepEqual(
    filterRecordings(recordings, { cacheState: "cached" }).map((item) => item.id),
    ["rec_cached_flagged", "rec_cached_status", "rec_uploaded_status"],
  );
  assert.deepEqual(
    filterRecordings(recordings, { cacheState: "missing" }).map((item) => item.id),
    ["rec_missing_path", "rec_active"],
  );
});

function recording(input: Partial<RecordingSummary>): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 60,
    folder: "Meetings",
    healthStatus: "healthy",
    id: "rec_test",
    name: "Council Voice",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: ["voice"],
    ...input,
  };
}
