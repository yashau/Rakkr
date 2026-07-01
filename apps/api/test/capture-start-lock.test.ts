import assert from "node:assert/strict";
import test from "node:test";

const { withCaptureStartLock } = await import("../src/capture-start-lock.js");

const yieldTwice = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("withCaptureStartLock serializes same-key operations (no interleaving)", async () => {
  const events: string[] = [];
  const op = (label: string) => async () => {
    events.push(`${label}:start`);
    await yieldTwice();
    events.push(`${label}:end`);
    return label;
  };

  const [a, b] = await Promise.all([
    withCaptureStartLock("node-1", op("A")),
    withCaptureStartLock("node-1", op("B")),
  ]);

  assert.equal(a, "A");
  assert.equal(b, "B");
  // B does not start until A has fully ended.
  assert.deepEqual(events, ["A:start", "A:end", "B:start", "B:end"]);
});

test("withCaptureStartLock lets different keys run concurrently", async () => {
  const events: string[] = [];
  await Promise.all([
    withCaptureStartLock("x", async () => {
      events.push("x:start");
      await yieldTwice();
      events.push("x:end");
    }),
    withCaptureStartLock("y", async () => {
      events.push("y:start");
      await yieldTwice();
      events.push("y:end");
    }),
  ]);

  // Both start before either ends — distinct keys are not serialized.
  assert.ok(events.indexOf("y:start") < events.indexOf("x:end"));
  assert.ok(events.indexOf("x:start") < events.indexOf("y:end"));
});

test("withCaptureStartLock does not wedge the queue when a holder throws", async () => {
  await assert.rejects(
    withCaptureStartLock("node-2", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  // The next operation on the same key still runs.
  const result = await withCaptureStartLock("node-2", async () => "recovered");
  assert.equal(result, "recovered");
});
