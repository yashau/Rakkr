import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent, RecorderNode } from "@rakkr/shared";

const { addChannelScopeTargets, addInterfaceScopeTargets, addNodeScopeTargets } = await import(
  "../src/scope-targets.js"
);

type AuditTarget = AuditEvent["target"];

function sharedNode(): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Shared Node",
    hostname: "shared-node",
    id: "node-shared",
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 4,
        channels: [
          { alias: "Ch 1", index: 1, roomId: "room-a" },
          { alias: "Ch 2", index: 2, roomId: "room-a" },
          { alias: "Ch 3", index: 3, roomId: "room-b" },
          { alias: "Ch 4", index: 4, roomId: "room-b" },
        ],
        id: "iface-1",
        sampleRates: [48000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Install Rack", site: "HQ" },
    status: "online",
    tags: [],
  };
}

function roomIds(targets: AuditTarget[]): string[] {
  return targets
    .filter((target) => target.type === "room" && target.id)
    .map((target) => target.id as string)
    .sort();
}

test("a channel target resolves to its own room only", () => {
  const nodes = [sharedNode()];

  const roomA: AuditTarget[] = [];
  addChannelScopeTargets(roomA, "iface-1:1", nodes);
  assert.deepEqual(roomIds(roomA), ["room-a"]);

  const roomB: AuditTarget[] = [];
  addChannelScopeTargets(roomB, "iface-1:3", nodes);
  assert.deepEqual(roomIds(roomB), ["room-b"]);
});

test("an interface target resolves to the union of its channels' rooms", () => {
  const targets: AuditTarget[] = [];
  addInterfaceScopeTargets(targets, "iface-1", [sharedNode()]);

  assert.deepEqual(roomIds(targets), ["room-a", "room-b"]);
});

test("a node target resolves to the union of all its channels' rooms", () => {
  const targets: AuditTarget[] = [];
  addNodeScopeTargets(targets, "node-shared", [sharedNode()]);

  assert.deepEqual(roomIds(targets), ["room-a", "room-b"]);
});

test("scope targets keep the resource hierarchy for node-grant matching", () => {
  const targets: AuditTarget[] = [];
  addChannelScopeTargets(targets, "iface-1:1", [sharedNode()]);

  const types = new Set(targets.map((target) => target.type));
  assert.ok(types.has("channel"));
  assert.ok(types.has("interface"));
  assert.ok(types.has("node"));
});
