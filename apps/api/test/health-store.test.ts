import assert from "node:assert/strict";
import test from "node:test";

import { createHealthEventStore } from "../src/health-store.js";
import { nodeOfflineEventType, scheduledLowSignalEventType } from "../src/watchdog-runner.js";

test("health event store filters by event type", async () => {
  const store = createHealthEventStore("", []);
  await store.create({
    nodeId: "node_test",
    severity: "critical",
    type: nodeOfflineEventType,
  });
  await store.create({
    nodeId: "node_test",
    recordingId: "rec_test",
    severity: "warning",
    type: scheduledLowSignalEventType,
  });

  const nodeOfflineEvents = await store.list({ type: nodeOfflineEventType });
  const lowSignalEvents = await store.list({ type: scheduledLowSignalEventType });

  assert.equal(nodeOfflineEvents.length, 1);
  assert.equal(nodeOfflineEvents[0]?.type, nodeOfflineEventType);
  assert.equal(lowSignalEvents.length, 1);
  assert.equal(lowSignalEvents[0]?.type, scheduledLowSignalEventType);
});
