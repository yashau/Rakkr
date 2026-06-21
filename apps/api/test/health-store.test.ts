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

test("health event store filters by opened date range", async () => {
  const store = createHealthEventStore("", []);
  await store.create({
    nodeId: "node_test",
    openedAt: new Date("2026-06-20T08:00:00.000Z"),
    severity: "warning",
    type: nodeOfflineEventType,
  });
  await store.create({
    nodeId: "node_test",
    openedAt: new Date("2026-06-20T14:00:00.000Z"),
    severity: "critical",
    type: scheduledLowSignalEventType,
  });
  await store.create({
    nodeId: "node_test",
    openedAt: new Date("2026-06-21T08:00:00.000Z"),
    severity: "warning",
    type: nodeOfflineEventType,
  });

  const events = await store.list({
    openedFrom: new Date("2026-06-20T10:00:00.000Z"),
    openedTo: new Date("2026-06-20T23:59:59.999Z"),
  });

  assert.deepEqual(
    events.map((healthEvent) => healthEvent.type),
    [scheduledLowSignalEventType],
  );
});

test("health event store filters by resolved date range", async () => {
  const store = createHealthEventStore("", []);
  const oldEvent = await store.create({
    nodeId: "node_test",
    openedAt: new Date("2026-06-19T08:00:00.000Z"),
    severity: "warning",
    type: nodeOfflineEventType,
  });
  const windowEvent = await store.create({
    nodeId: "node_test",
    openedAt: new Date("2026-06-20T08:00:00.000Z"),
    severity: "critical",
    type: scheduledLowSignalEventType,
  });
  await store.create({
    nodeId: "node_test",
    openedAt: new Date("2026-06-20T09:00:00.000Z"),
    severity: "warning",
    type: nodeOfflineEventType,
  });

  await store.updateLifecycle(oldEvent.id, {
    resolvedAt: new Date("2026-06-19T12:00:00.000Z"),
    resolvedBy: "tester",
    status: "resolved",
  });
  await store.updateLifecycle(windowEvent.id, {
    resolvedAt: new Date("2026-06-20T12:00:00.000Z"),
    resolvedBy: "tester",
    status: "resolved",
  });

  const events = await store.list({
    resolvedFrom: new Date("2026-06-20T00:00:00.000Z"),
    resolvedTo: new Date("2026-06-20T23:59:59.999Z"),
  });

  assert.deepEqual(
    events.map((healthEvent) => healthEvent.type),
    [scheduledLowSignalEventType],
  );
});
