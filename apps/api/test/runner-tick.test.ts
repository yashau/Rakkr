import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseUnavailableError } from "../src/database-unavailable.js";
import { reportRunnerTickError } from "../src/runner-tick.js";

test("reportRunnerTickError never rethrows, so a scheduled tick cannot crash the process", () => {
  const handle = reportRunnerTickError("test runner");

  // Every runner wires this into `void tick().catch(handle)`. If the handler
  // rethrew, it would re-create the unhandled promise rejection G4-1 introduced
  // (a DB blip in a runner tick crashing the API under Node's default
  // unhandled-rejections=throw). It must swallow everything.
  assert.doesNotThrow(() => handle(new DatabaseUnavailableError("postgres unreachable")));
  assert.doesNotThrow(() => handle(new Error("unexpected")));
  assert.doesNotThrow(() => handle("not even an error"));
  assert.doesNotThrow(() => handle(undefined));
});

test("a rejected tick routed through the handler settles instead of going unhandled", async () => {
  const handle = reportRunnerTickError("test runner");
  const tick = async () => {
    throw new DatabaseUnavailableError("postgres unreachable");
  };

  // Mirrors the runner wiring: `void tick().catch(handle)`. Awaiting proves the
  // resulting promise resolves (settles) rather than rejecting.
  await assert.doesNotReject(tick().catch(handle));
});
