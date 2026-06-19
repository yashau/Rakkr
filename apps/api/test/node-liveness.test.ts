import assert from "node:assert/strict";
import test from "node:test";
import type { RecorderNode } from "@rakkr/shared";

import {
  deriveNodeStatus,
  nodeHeartbeatAgeSeconds,
  nodeHeartbeatStale,
  nodeOfflineAfterSeconds,
  nodeWithDerivedLiveness,
} from "../src/node-liveness.js";

test("stale nodes derive offline status", () => {
  assert.equal(
    deriveNodeStatus(node({ status: "recording" }), new Date("2026-06-18T12:03:01.000Z"), 180),
    "offline",
  );
});

test("fresh nodes keep their reported status", () => {
  assert.equal(
    deriveNodeStatus(node({ status: "recording" }), new Date("2026-06-18T12:02:59.000Z"), 180),
    "recording",
  );
});

test("zero threshold disables stale offline derivation", () => {
  assert.equal(
    deriveNodeStatus(node({ status: "alerting" }), new Date("2026-06-18T13:00:00.000Z"), 0),
    "alerting",
  );
});

test("derived liveness returns the original node when status is unchanged", () => {
  const active = node({ status: "online" });

  assert.equal(nodeWithDerivedLiveness(active, new Date("2026-06-18T12:00:30.000Z"), 120), active);
});

test("derived liveness returns a copied node when status changes", () => {
  const stale = node({ status: "online" });
  const derived = nodeWithDerivedLiveness(stale, new Date("2026-06-18T12:02:01.000Z"), 120);

  assert.notEqual(derived, stale);
  assert.equal(derived.status, "offline");
});

test("offline threshold comes from environment with safe fallback", () => {
  assert.equal(nodeOfflineAfterSeconds({ RAKKR_NODE_OFFLINE_AFTER_SECONDS: "45" }), 45);
  assert.equal(nodeOfflineAfterSeconds({ RAKKR_NODE_OFFLINE_AFTER_SECONDS: "-1" }), 120);
});

test("heartbeat age and stale checks use the same threshold semantics", () => {
  const stale = node({ status: "online" });

  assert.equal(nodeHeartbeatAgeSeconds(stale, new Date("2026-06-18T12:02:01.000Z")), 121);
  assert.equal(nodeHeartbeatStale(stale, new Date("2026-06-18T12:02:01.000Z"), 120), true);
  assert.equal(nodeHeartbeatStale(stale, new Date("2026-06-18T12:02:00.000Z"), 120), false);
});

function node(input: Pick<RecorderNode, "status">): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Council Chamber",
    hostname: "rakkr-node",
    id: "node_test",
    interfaces: [],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Council Chamber",
      site: "Main Office",
    },
    status: input.status,
    tags: [],
  };
}
