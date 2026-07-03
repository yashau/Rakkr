import assert from "node:assert/strict";
import test from "node:test";
import type { RecorderNode } from "@rakkr/shared";

const { channelRoomId, effectiveCaptureInterfaceId, nodeRoomIds, resolveSelectionRoom } =
  await import("../src/room-resolution.js");
const { resolveScheduleRoom, scheduleChannelSelectionFailure } =
  await import("../src/schedule-route-helpers.js");

function withCaptureInterfaceEnv(value: string | undefined, run: () => void) {
  const previous = process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID;

  try {
    if (value === undefined) {
      delete process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID;
    } else {
      process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID = value;
    }

    run();
  } finally {
    if (previous === undefined) {
      delete process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID;
    } else {
      process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID = previous;
    }
  }
}

function node(overrides: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Node A",
    hostname: "node-a",
    id: "node-a",
    interfaces: [],
    ipAddresses: ["10.0.0.5"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Chamber", site: "HQ" },
    status: "online",
    tags: [],
    ...overrides,
  };
}

function iface(id: string, channels: Array<{ index: number; roomId?: string }>) {
  return {
    alias: id,
    backend: "alsa" as const,
    channelCount: channels.length,
    channels: channels.map((channel) => ({
      alias: `Channel ${channel.index}`,
      index: channel.index,
      roomId: channel.roomId,
    })),
    id,
    sampleRates: [48000],
    systemName: id,
    systemRef: `hw:CARD=${id}`,
  };
}

test("channelRoomId prefers the channel room and falls back to the node default", () => {
  const target = node({
    roomId: "room-default",
    interfaces: [iface("iface-1", [{ index: 1, roomId: "room-chamber" }, { index: 2 }])],
  });

  assert.equal(channelRoomId(target, "iface-1", 1), "room-chamber");
  assert.equal(channelRoomId(target, "iface-1", 2), "room-default");
  assert.equal(channelRoomId(target, "iface-1", 99), "room-default");
  assert.equal(channelRoomId(target, "missing", 1), "room-default");
});

test("nodeRoomIds unions the effective room of every channel", () => {
  const shared = node({
    roomId: "room-a",
    interfaces: [
      iface("iface-1", [
        { index: 1, roomId: "room-a" },
        { index: 2, roomId: "room-b" },
        { index: 3 },
      ]),
    ],
  });

  assert.deepEqual([...nodeRoomIds(shared)].sort(), ["room-a", "room-b"]);
});

test("nodeRoomIds drops the node default once every channel is assigned away", () => {
  const carved = node({
    roomId: "room-a",
    interfaces: [
      iface("iface-1", [
        { index: 1, roomId: "room-b" },
        { index: 2, roomId: "room-c" },
      ]),
    ],
  });

  assert.deepEqual([...nodeRoomIds(carved)].sort(), ["room-b", "room-c"]);
});

test("nodeRoomIds falls back to the node default for a node with no channels", () => {
  const bare = node({ roomId: "room-a", interfaces: [] });

  assert.deepEqual([...nodeRoomIds(bare)], ["room-a"]);
});

test("resolveSelectionRoom returns the single room a selection maps to", () => {
  const target = node({
    interfaces: [
      iface("iface-1", [
        { index: 1, roomId: "room-a" },
        { index: 2, roomId: "room-a" },
        { index: 3, roomId: "room-b" },
      ]),
    ],
  });

  assert.deepEqual(resolveSelectionRoom(target, "iface-1", [1, 2]), {
    ok: true,
    roomId: "room-a",
  });
});

test("resolveSelectionRoom rejects a selection spanning rooms", () => {
  const target = node({
    interfaces: [
      iface("iface-1", [
        { index: 1, roomId: "room-a" },
        { index: 3, roomId: "room-b" },
      ]),
    ],
  });

  assert.equal(resolveSelectionRoom(target, "iface-1", [1, 3]).ok, false);
});

test("resolveSelectionRoom over the whole interface uses every channel's room", () => {
  const singleRoom = node({
    interfaces: [
      iface("iface-1", [
        { index: 1, roomId: "room-a" },
        { index: 2, roomId: "room-a" },
      ]),
    ],
  });
  const multiRoom = node({
    interfaces: [
      iface("iface-1", [
        { index: 1, roomId: "room-a" },
        { index: 2, roomId: "room-b" },
      ]),
    ],
  });

  assert.deepEqual(resolveSelectionRoom(singleRoom, "iface-1", "all"), {
    ok: true,
    roomId: "room-a",
  });
  assert.equal(resolveSelectionRoom(multiRoom, "iface-1", "all").ok, false);
});

test("effectiveCaptureInterfaceId prefers explicit id, then the env default, then first interface", () => {
  const target = node({
    interfaces: [iface("iface-1", [{ index: 1 }]), iface("iface-2", [{ index: 1 }])],
  });

  withCaptureInterfaceEnv(undefined, () => {
    assert.equal(effectiveCaptureInterfaceId(target, "iface-2"), "iface-2");
    assert.equal(effectiveCaptureInterfaceId(target, null), "iface-1");
  });

  withCaptureInterfaceEnv("iface-2", () => {
    assert.equal(effectiveCaptureInterfaceId(target, null), "iface-2");
    assert.equal(effectiveCaptureInterfaceId(target, "iface-1"), "iface-1");
  });
});

test("resolveScheduleRoom honors RAKKR_AGENT_CAPTURE_INTERFACE_ID like the recorder runtime", () => {
  const target = node({
    roomId: "room-default",
    interfaces: [
      iface("iface-first", [{ index: 1, roomId: "room-a" }]),
      iface("iface-env", [{ index: 1, roomId: "room-b" }]),
    ],
  });

  withCaptureInterfaceEnv("iface-env", () => {
    // The schedule pins no interface: the attributed room must match the interface
    // the runtime actually captures (iface-env -> room-b), not interfaces[0] (room-a),
    // so the persisted roomId cannot diverge from the captured room.
    assert.deepEqual(resolveScheduleRoom(target, null, null), { ok: true, roomId: "room-b" });
  });
});

test("scheduleChannelSelectionFailure validates against the effective (env) capture interface", () => {
  const target = node({
    roomId: "room-default",
    interfaces: [
      // interfaces[0] has channel 3; the env-selected interface does NOT.
      iface("iface-first", [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }]),
      iface("iface-env", [{ index: 1 }, { index: 2 }]),
    ],
  });

  withCaptureInterfaceEnv(undefined, () => {
    // No env: validate against interfaces[0] (iface-first), where channel 3 is valid.
    assert.equal(scheduleChannelSelectionFailure(target, null, [3], "mono"), undefined);
  });

  withCaptureInterfaceEnv("iface-env", () => {
    // The controller pins iface-env — the interface the runtime actually captures.
    // Channel 3 is out of range there, so validation must reject it, matching the
    // attributed room + runtime capture (which both use the effective interface).
    assert.ok(
      scheduleChannelSelectionFailure(target, null, [3], "mono"),
      "a selection invalid on the env-pinned interface must be rejected, not validated against interfaces[0]",
    );
    // An explicit interface still wins over the env default.
    assert.equal(scheduleChannelSelectionFailure(target, "iface-first", [3], "mono"), undefined);
  });
});

test("resolveSelectionRoom falls back to the node default for unassigned channels", () => {
  const target = node({
    roomId: "room-default",
    interfaces: [iface("iface-1", [{ index: 1 }, { index: 2 }])],
  });

  assert.deepEqual(resolveSelectionRoom(target, "iface-1", [1, 2]), {
    ok: true,
    roomId: "room-default",
  });
});
