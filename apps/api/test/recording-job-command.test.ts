import assert from "node:assert/strict";
import test from "node:test";

import { commandFromValue } from "../src/recording-job-command.js";

test("commandFromValue preserves recorder-cache retention thresholds on deserialization", () => {
  // A persisted recorder_cache retention policy carries the deferred-cleanup
  // thresholds the agent needs (maxAgeDays / maxBytes / minFreeDiskPercent). They
  // must survive the DB round-trip — dropping them to just
  // {deleteAfterUpload, policyId} left the agent unable to run age/bytes/disk
  // sweeps, so the recorder cache grew unbounded.
  const command = commandFromValue({
    outputFileName: "rec.mp3",
    recorderCacheRetention: {
      deleteAfterUpload: true,
      maxAgeDays: 30,
      maxBytes: 1_000_000,
      minFreeDiskPercent: 15,
      policyId: "retention-recorder-cache",
    },
    type: "alsa_capture",
  });

  assert.deepEqual(command.recorderCacheRetention, {
    deleteAfterUpload: true,
    maxAgeDays: 30,
    maxBytes: 1_000_000,
    minFreeDiskPercent: 15,
    policyId: "retention-recorder-cache",
  });
});

test("commandFromValue keeps a null retention threshold and omits absent ones", () => {
  const command = commandFromValue({
    recorderCacheRetention: {
      deleteAfterUpload: false,
      maxAgeDays: null,
      policyId: "p",
    },
    type: "alsa_capture",
  });

  assert.equal(command.recorderCacheRetention?.deleteAfterUpload, false);
  assert.equal(command.recorderCacheRetention?.maxAgeDays, null);
  assert.equal(command.recorderCacheRetention?.maxBytes, undefined);
  assert.equal(command.recorderCacheRetention?.minFreeDiskPercent, undefined);
});
