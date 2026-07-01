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
    // Now deterministically id-tiebroken for equal recordedAt (was input order).
    filterRecordings(recordings, { cacheState: "missing" }).map((item) => item.id),
    ["rec_active", "rec_missing_path"],
  );
});

test("recording listing searches transcript snippets", () => {
  const recordings = [
    recording({
      id: "rec_transcript_match",
      transcriptSnippets: ["The zoning motion passed after public comment."],
    }),
    recording({
      id: "rec_notes_only",
      notes: "Budget hearing",
      transcriptSnippets: ["No matching phrase here."],
    }),
  ];

  assert.deepEqual(
    filterRecordings(recordings, { search: "zoning motion" }).map((item) => item.id),
    ["rec_transcript_match"],
  );
});

test("G66: equal recordedAt recordings sort deterministically without an explicit sortBy", () => {
  const sameTime = "2026-06-18T09:00:00.000Z";
  const forward = [
    recording({ id: "rec_track_a", recordedAt: sameTime }),
    recording({ id: "rec_track_b", recordedAt: sameTime }),
  ];
  const reversed = [
    recording({ id: "rec_track_b", recordedAt: sameTime }),
    recording({ id: "rec_track_a", recordedAt: sameTime }),
  ];

  // Pre-fix, no sortBy returned input order as-is, so equal-recordedAt rows
  // ordered nondeterministically — across paged requests a boundary could skip or
  // duplicate a row. The id tiebreaker now makes the order stable.
  assert.deepEqual(
    filterRecordings(forward, {}).map((item) => item.id),
    filterRecordings(reversed, {}).map((item) => item.id),
  );
  assert.deepEqual(
    filterRecordings(forward, {}).map((item) => item.id),
    ["rec_track_a", "rec_track_b"],
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
