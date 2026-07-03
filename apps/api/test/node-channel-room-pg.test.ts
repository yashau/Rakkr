import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// Postgres-backed round-trip for PostgresNodeStore.assignChannelRooms — the
// default suites run against SeedOnlyNodeStore, so the real per-channel room
// persistence (audio_channels.room_id) was never exercised. Runs only when a test
// DB is provided via RAKKR_API_TEST_DATABASE_URL; otherwise it skips and opens no
// pool. DATABASE_URL must be set BEFORE importing the stores.
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close, so the process would otherwise idle until the runner's exit timeout.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const { createNodeStore } = await import("../src/node-store.js");
const { createRoomStore } = await import("../src/room-store.js");

test(
  "PostgresNodeStore.assignChannelRooms persists per-channel room assignments",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const room = await createRoomStore().create({
      id: `room_pg_${suffix}`,
      name: `PG Room ${suffix}`,
      site: `Site ${suffix}`,
    });

    const nodeStore = createNodeStore();
    const enrollment = await nodeStore.enroll({
      agentVersion: "0.0.0-test",
      alias: `Channel Room Node ${suffix}`,
      hostname: `channel-room-${suffix}.local`,
      interfaces: [
        {
          alias: "X32",
          backend: "alsa",
          channelCount: 2,
          channels: [
            { alias: "Ch 1", index: 1 },
            { alias: "Ch 2", index: 2 },
          ],
          sampleRates: [48000],
          systemName: `X-USB ${suffix}`,
          systemRef: `hw:CARD=${suffix}`,
        },
      ],
      ipAddresses: [],
      location: { room: "Rack", site: `Site ${suffix}` },
      tags: [],
    });
    const nodeId = enrollment.node.id;
    const interfaceId = enrollment.node.interfaces[0]?.id;
    assert.ok(interfaceId, "enrolled node has an interface id");

    const channelRoom = (node: Awaited<ReturnType<typeof nodeStore.find>>, index: number) =>
      node?.interfaces
        .find((iface) => iface.id === interfaceId)
        ?.channels.find((channel) => channel.index === index)?.roomId;

    // Assign channel 1 to the room; channel 2 stays unassigned.
    const assigned = await nodeStore.assignChannelRooms(nodeId, [
      { channelIndex: 1, interfaceId, roomId: room.id },
    ]);
    assert.equal(channelRoom(assigned, 1), room.id, "channel 1 is assigned to the room");
    assert.equal(channelRoom(assigned, 2), undefined, "channel 2 stays unassigned");

    // Round-trip via a FRESH store instance so the assertion reads the DB, not the
    // in-memory return value of the writing instance.
    const reread = await createNodeStore().find(nodeId);
    assert.equal(channelRoom(reread, 1), room.id, "the assignment persists across a fresh read");

    // Clearing the assignment (roomId null) persists as unassigned.
    const cleared = await nodeStore.assignChannelRooms(nodeId, [
      { channelIndex: 1, interfaceId, roomId: null },
    ]);
    assert.equal(channelRoom(cleared, 1), undefined, "clearing the room persists as unassigned");
  },
);
