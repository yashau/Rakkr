import assert from "node:assert/strict";
import test from "node:test";
import type { RecorderNode } from "@rakkr/shared";

import { heartbeatStatus, updatedNodeHeartbeat } from "../src/node-store-updates.js";

const baseNode: RecorderNode = {
  agentVersion: "0.0.0-dev",
  alias: "Council Chamber",
  hostname: "council-node",
  id: "node_council",
  interfaces: [],
  ipAddresses: ["10.0.0.10"],
  lastSeenAt: "2026-06-18T12:00:00.000Z",
  location: { room: "Council Chamber", site: "Main Office" },
  status: "provisioning",
  tags: [],
};

test("heartbeatStatus promotes never-contacted/stale statuses to online", () => {
  // A heartbeat proves the node is in contact, so it can never leave the node
  // looking never-contacted (provisioning) or stale (offline).
  assert.equal(heartbeatStatus("provisioning"), "online");
  assert.equal(heartbeatStatus("offline"), "online");
  // Genuine live statuses pass through unchanged.
  assert.equal(heartbeatStatus("online"), "online");
  assert.equal(heartbeatStatus("recording"), "recording");
  assert.equal(heartbeatStatus("degraded"), "degraded");
  assert.equal(heartbeatStatus("alerting"), "alerting");
});

test("first heartbeat promotes a provisioning node to a live status", () => {
  const updated = updatedNodeHeartbeat(baseNode, {
    agentVersion: "2026.06.28-1",
    hostname: baseNode.hostname,
    ipAddresses: baseNode.ipAddresses,
    status: "online",
  });

  assert.equal(baseNode.status, "provisioning");
  assert.equal(updated.status, "online");
});

test("a heartbeat cannot un-promote a live node back to provisioning", () => {
  // A stale/rolled-back/hostile agent reporting `provisioning` must not suppress
  // offline detection for a node that is actually alive (audit N4).
  const live: RecorderNode = { ...baseNode, status: "online" };
  const updated = updatedNodeHeartbeat(live, {
    agentVersion: "2026.06.28-1",
    hostname: live.hostname,
    ipAddresses: live.ipAddresses,
    status: "provisioning",
  });

  assert.equal(updated.status, "online");
});
