import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

import { isCachedRecording, isTerminalRecording } from "./recording-page-helpers";

test("recording action helpers identify cached files for playback download and upload", () => {
  assert.equal(isCachedRecording(recording({ cached: true, cachePath: "ad-hoc/rec.mp3" })), true);
  assert.equal(
    isCachedRecording(recording({ cachePath: "ad-hoc/rec.mp3", status: "cached" })),
    true,
  );
  assert.equal(
    isCachedRecording(recording({ cachePath: "ad-hoc/rec.mp3", status: "uploaded" })),
    true,
  );
  assert.equal(isCachedRecording(recording({ cached: true, cachePath: undefined })), false);
  assert.equal(
    isCachedRecording(recording({ cachePath: "ad-hoc/rec.mp3", status: "recording" })),
    false,
  );
});

test("recording action helpers keep destructive actions off active recordings", () => {
  assert.equal(isTerminalRecording(recording({ status: "queued" })), false);
  assert.equal(isTerminalRecording(recording({ status: "recording" })), false);
  assert.equal(isTerminalRecording(recording({ status: "failed" })), true);
  assert.equal(isTerminalRecording(recording({ status: "cached" })), true);
  assert.equal(isTerminalRecording(recording({ status: "uploaded" })), true);
});

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 60,
    folder: "meetings/2026-06-18",
    healthStatus: "healthy",
    id: "rec_web_action_test",
    name: "Council Voice",
    nodeId: "node_web_action_test",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: ["voice"],
    ...input,
  };
}
