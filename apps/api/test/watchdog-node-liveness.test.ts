import assert from "node:assert/strict";
import test from "node:test";
import type { RecorderNode } from "@rakkr/shared";

import { createAuditStore } from "../src/audit-store.js";
import { createHealthEventStore } from "../src/health-store.js";
import type { HealthEventStore } from "../src/health-store.js";
import { reconcileNodeLivenessEvents } from "../src/watchdog-node-liveness.js";

function node(id: string, overrides: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: id,
    hostname: `${id}.local`,
    id,
    interfaces: [],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Council Chamber", site: "Main Office" },
    status: "online",
    tags: [],
    ...overrides,
  };
}

test("R4-2: a failing node reconcile is isolated and later nodes still reconcile", async () => {
  const auditStore = createAuditStore("");
  const real = createHealthEventStore("", []);
  // The first node's health-event lookup throws; the sweep must skip it and go on.
  // Delegate every method to the real (class-based) store and intercept only
  // `list` so node_bad's lookup fails.
  const healthEventStore: HealthEventStore = {
    count: (filters) => real.count(filters),
    create: (input) => real.create(input),
    find: (eventId) => real.find(eventId),
    async list(filters) {
      if (filters?.nodeId === "node_bad") {
        throw new Error("health store unavailable");
      }

      return real.list(filters);
    },
    listAll: (filters) => real.listAll(filters),
    update: (eventId, update) => real.update(eventId, update),
    updateLifecycle: (eventId, update) => real.updateLifecycle(eventId, update),
  };

  // Both nodes are stale (last seen 12:00, now 12:05) so both would normally
  // raise an offline alert.
  const results = await reconcileNodeLivenessEvents({
    auditStore,
    healthEventStore,
    nodes: [node("node_bad"), node("node_good")],
    now: new Date("2026-06-18T12:05:00.000Z"),
  });

  const bad = results.find((result) => result.nodeId === "node_bad");
  const good = results.find((result) => result.nodeId === "node_good");

  // Pre-fix the thrown error propagated out of the loop, aborting the whole
  // sweep so node_good was never evaluated (offline nodes stayed unflagged).
  assert.equal(bad?.outcome, "skipped");
  assert.equal(bad?.reason, "reconcile_failed");
  assert.equal(good?.outcome, "alert_created");

  const goodEvents = await healthEventStore.list({ nodeId: "node_good" });
  assert.equal(goodEvents.length, 1);
});
