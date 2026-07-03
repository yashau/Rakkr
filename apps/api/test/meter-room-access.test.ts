import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, MeterFrame, RecorderNode } from "@rakkr/shared";
import type { AuditTarget } from "../src/http-types.js";

const { createMeterRoomAccess } = await import("../src/meter-room-access.js");

// A shared node: interface if1 channel 1 -> room-a, channel 2 -> room-b.
function sharedNode(): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Shared",
    hostname: "shared",
    id: "node-1",
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 2,
        channels: [
          { alias: "A", index: 1, roomId: "room-a" },
          { alias: "B", index: 2, roomId: "room-b" },
        ],
        id: "if1",
        sampleRates: [48000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Rack", site: "HQ" },
    status: "online",
    tags: [],
  };
}

function frame(): MeterFrame {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    interfaceId: "if1",
    levels: [
      { channelIndex: 1, clipping: false, label: "A", peakDbfs: -6, rmsDbfs: -12 },
      { channelIndex: 2, clipping: false, label: "B", peakDbfs: -6, rmsDbfs: -12 },
    ],
    nodeId: "node-1",
  };
}

function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    email: "u@example.com",
    groups: [],
    id: "user_1",
    name: "U",
    permissions: [],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
    ...overrides,
  };
}

// Room-A-only access via a ROOM resource grant (not roster, not a node grant).
function roomAAccess() {
  return createMeterRoomAccess({
    accessPolicyDecision: async () => undefined,
    hasResourceScope: async (_u, target: AuditTarget) =>
      target.type === "room" && target.id === "room-a",
    rosterRoomIds: async () => new Set<string>(),
  });
}

test("a room-scoped grant does NOT confer whole-node authority on a shared node", async () => {
  const access = roomAAccess();
  const roomAUser = user({ resourceGrants: [{ resourceId: "room-a", resourceType: "room" }] });

  const rooms = await access.meterRoomAccess(roomAUser, sharedNode());

  // The old bug returned "all" here (node scope expands to the room union); it must
  // resolve to exactly the caller's owned room.
  assert.notEqual(rooms, "all");
  assert.deepEqual([...(rooms as Set<string>)], ["room-a"]);
});

test("room-scoped caller is refused whole-node monitor audio and gets filtered meters", async () => {
  const access = roomAAccess();
  const roomAUser = user({ resourceGrants: [{ resourceId: "room-a", resourceType: "room" }] });

  const canListen = await access.canServeWholeNodeMonitor(roomAUser, sharedNode());
  const filtered = await access.filterMeterFrameForUser(roomAUser, sharedNode(), frame());

  // Node has a room-b channel the caller does not own -> no whole-node audio.
  assert.equal(canListen, false);
  // Meters keep only the room-a channel.
  assert.deepEqual(
    filtered.levels.map((level) => level.channelIndex),
    [1],
  );
});

test("a direct node grant confers whole-node authority", async () => {
  const access = roomAAccess();
  const nodeUser = user({ resourceGrants: [{ resourceId: "node-1", resourceType: "node" }] });

  assert.equal(await access.meterRoomAccess(nodeUser, sharedNode()), "all");
  assert.equal(await access.canServeWholeNodeMonitor(nodeUser, sharedNode()), true);
  assert.equal(
    (await access.filterMeterFrameForUser(nodeUser, sharedNode(), frame())).levels.length,
    2,
  );
});

test("owner has whole-node authority", async () => {
  const access = roomAAccess();
  const owner = user({ roles: ["owner"] });

  assert.equal(await access.meterRoomAccess(owner, sharedNode()), "all");
  assert.equal(await access.canServeWholeNodeMonitor(owner, sharedNode()), true);
});
