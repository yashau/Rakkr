import assert from "node:assert/strict";
import test from "node:test";
import type { RecorderNode } from "@rakkr/shared";

const { createNodeStore, NodeStoreError } = await import("../src/node-store.js");

function seedNode(): RecorderNode {
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
          { alias: "Ch 1", index: 1 },
          { alias: "Ch 2", index: 2 },
          { alias: "Ch 3", index: 3 },
          { alias: "Ch 4", index: 4 },
        ],
        id: "iface-1",
        sampleRates: [48000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Chamber", site: "HQ" },
    roomId: "room-default",
    status: "online",
    tags: [],
  };
}

test("assignChannelRooms partitions a node's channels across rooms", async () => {
  const store = createNodeStore([seedNode()]);

  const updated = await store.assignChannelRooms("node-shared", [
    { channelIndex: 1, interfaceId: "iface-1", roomId: "room-a" },
    { channelIndex: 2, interfaceId: "iface-1", roomId: "room-a" },
    { channelIndex: 3, interfaceId: "iface-1", roomId: "room-b" },
  ]);

  const channels = updated?.interfaces[0].channels ?? [];
  assert.equal(channels.find((channel) => channel.index === 1)?.roomId, "room-a");
  assert.equal(channels.find((channel) => channel.index === 2)?.roomId, "room-a");
  assert.equal(channels.find((channel) => channel.index === 3)?.roomId, "room-b");
  assert.equal(channels.find((channel) => channel.index === 4)?.roomId, undefined);
});

test("assignChannelRooms clears a channel room with a null assignment", async () => {
  const store = createNodeStore([seedNode()]);

  await store.assignChannelRooms("node-shared", [
    { channelIndex: 1, interfaceId: "iface-1", roomId: "room-a" },
  ]);
  const cleared = await store.assignChannelRooms("node-shared", [
    { channelIndex: 1, interfaceId: "iface-1", roomId: null },
  ]);

  assert.equal(cleared?.interfaces[0].channels[0].roomId, undefined);
});

test("assignChannelRooms returns undefined for an unknown node", async () => {
  const store = createNodeStore([seedNode()]);

  const result = await store.assignChannelRooms("missing-node", [
    { channelIndex: 1, interfaceId: "iface-1", roomId: "room-a" },
  ]);

  assert.equal(result, undefined);
});

test("assignChannelRooms rejects an interface that is not on the node", async () => {
  const store = createNodeStore([seedNode()]);

  await assert.rejects(
    () =>
      store.assignChannelRooms("node-shared", [
        { channelIndex: 1, interfaceId: "iface-other", roomId: "room-a" },
      ]),
    (error) => error instanceof NodeStoreError && error.code === "interface_not_found",
  );
});

test("assignChannelRooms rejects a channel index out of range", async () => {
  const store = createNodeStore([seedNode()]);

  await assert.rejects(
    () =>
      store.assignChannelRooms("node-shared", [
        { channelIndex: 99, interfaceId: "iface-1", roomId: "room-a" },
      ]),
    (error) => error instanceof NodeStoreError && error.code === "channel_not_found",
  );
});
