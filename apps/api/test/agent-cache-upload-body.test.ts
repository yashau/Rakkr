import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedBody, recordingCacheUploadMaxBytes } from "../src/agent-cache-upload-body.js";

function request(body: Uint8Array | null): Request {
  return new Request("https://controller.local/api/v1/recordings/rec/cache-file", {
    body,
    // A body requires a method that permits one; duplex is needed for a stream body.
    duplex: "half",
    method: "PUT",
  } as RequestInit & { duplex: "half" });
}

test("readBoundedBody returns the full body when within the cap", async () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const result = await readBoundedBody(request(payload), 1024);

  assert.notEqual(result, "too_large");
  assert.deepEqual(result, payload);
});

test("readBoundedBody aborts a body that exceeds the cap", async () => {
  // A compromised node credential must not be able to stream an unbounded body:
  // the reader must stop and report once the running total passes the ceiling.
  const payload = new Uint8Array(4096);
  const result = await readBoundedBody(request(payload), 1024);

  assert.equal(result, "too_large");
});

test("readBoundedBody treats an exactly-at-cap body as acceptable", async () => {
  const payload = new Uint8Array(1024);
  const result = await readBoundedBody(request(payload), 1024);

  assert.notEqual(result, "too_large");
  assert.equal((result as Uint8Array).byteLength, 1024);
});

test("readBoundedBody returns an empty array for no body", async () => {
  const result = await readBoundedBody(request(null), 1024);

  assert.notEqual(result, "too_large");
  assert.equal((result as Uint8Array).byteLength, 0);
});

test("recordingCacheUploadMaxBytes reads the env override and falls back to a bounded default", () => {
  const original = process.env.RAKKR_RECORDING_CACHE_MAX_BYTES;

  try {
    process.env.RAKKR_RECORDING_CACHE_MAX_BYTES = "2048";
    assert.equal(recordingCacheUploadMaxBytes(), 2048);

    delete process.env.RAKKR_RECORDING_CACHE_MAX_BYTES;
    const fallback = recordingCacheUploadMaxBytes();
    assert.ok(Number.isInteger(fallback) && fallback > 0);
    assert.ok(fallback <= 8 * 1024 * 1024 * 1024, "default must be a bounded ceiling");

    process.env.RAKKR_RECORDING_CACHE_MAX_BYTES = "not-a-number";
    assert.equal(
      recordingCacheUploadMaxBytes(),
      fallback,
      "invalid override falls back to default",
    );
  } finally {
    if (original === undefined) {
      delete process.env.RAKKR_RECORDING_CACHE_MAX_BYTES;
    } else {
      process.env.RAKKR_RECORDING_CACHE_MAX_BYTES = original;
    }
  }
});
