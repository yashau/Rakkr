import assert from "node:assert/strict";
import test from "node:test";
import { chunkedRecordingFinalization } from "../src/upload-runner.js";

test("all chunks present and uploaded finalizes as uploaded", () => {
  assert.deepEqual(
    chunkedRecordingFinalization({
      captureDone: false,
      chunkStatuses: ["uploaded", "uploaded", "uploaded"],
      presentCount: 3,
      total: 3,
    }),
    { status: "uploaded" },
  );
});

test("G43: a dropped-chunk gap finalizes as partial once capture is done (not stuck)", () => {
  // A render failure orphaned chunk 2: 2 rows present, total 3. Pre-fix the gate
  // required chunks.length >= total, so this returned undefined forever and the
  // recording hung in `cached`. With the job terminal, it must finalize partial.
  assert.deepEqual(
    chunkedRecordingFinalization({
      captureDone: true,
      chunkStatuses: ["uploaded", "uploaded"],
      presentCount: 2,
      total: 3,
    }),
    { status: "partial" },
  );
});

test("a gap does NOT finalize while capture is still running (no premature partial)", () => {
  assert.equal(
    chunkedRecordingFinalization({
      captureDone: false,
      chunkStatuses: ["uploaded", "uploaded"],
      presentCount: 2,
      total: 3,
    }),
    undefined,
  );
});

test("does not finalize until every present chunk has settled", () => {
  assert.equal(
    chunkedRecordingFinalization({
      captureDone: true,
      chunkStatuses: ["uploaded", "uploading"],
      presentCount: 2,
      total: 2,
    }),
    undefined,
  );
});

test("all chunks failed stays cached (no finalize, still retryable)", () => {
  assert.equal(
    chunkedRecordingFinalization({
      captureDone: true,
      chunkStatuses: ["failed", "failed"],
      presentCount: 2,
      total: 2,
    }),
    undefined,
  );
});

test("a degraded (partial) chunk finalizes the recording as partial", () => {
  assert.deepEqual(
    chunkedRecordingFinalization({
      captureDone: false,
      chunkStatuses: ["uploaded", "partial", "uploaded"],
      presentCount: 3,
      total: 3,
    }),
    { status: "partial" },
  );
});
