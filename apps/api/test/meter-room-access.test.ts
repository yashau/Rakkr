import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, MeterFrame, RecorderNode } from "@rakkr/shared";
import type { AuditTarget } from "../src/http-types.js";

const { createMeterRoomAccess, resolveVisibleMeterFrame } =
  await import("../src/meter-room-access.js");

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

test("resolveVisibleMeterFrame streams only the caller's room channels (SSE per-channel filter)", async () => {
  const access = roomAAccess();
  const roomAUser = user({ resourceGrants: [{ resourceId: "room-a", resourceType: "room" }] });
  // The scoped-node resolver mirrors /meters' findScopedNode: it returns the node
  // only when it is in the caller's scoped set (roster-inclusive), else undefined.
  const resolvesNode = async (_u: CurrentUser, id: string) =>
    id === "node-1" ? sharedNode() : undefined;
  const outOfScope = async () => undefined;

  // The node resolves within scope, then the same strict per-channel filter as
  // /meters keeps only the room-a channel.
  const visible = await resolveVisibleMeterFrame(roomAUser, frame(), {
    filterMeterFrame: access.filterMeterFrameForUser,
    resolveScopedNode: resolvesNode,
  });

  assert.deepEqual(
    visible?.levels.map((level) => level.channelIndex),
    [1],
    "sibling-room channel levels are stripped before streaming",
  );

  // Node not in the caller's scope -> the stream emits nothing.
  const denied = await resolveVisibleMeterFrame(roomAUser, frame(), {
    filterMeterFrame: access.filterMeterFrameForUser,
    resolveScopedNode: outOfScope,
  });

  assert.equal(denied, undefined, "an out-of-scope node streams nothing");

  // An unresolvable node -> never a fall-back to the unfiltered frame.
  const missing = await resolveVisibleMeterFrame(
    roomAUser,
    { ...frame(), nodeId: "ghost" },
    {
      filterMeterFrame: access.filterMeterFrameForUser,
      resolveScopedNode: resolvesNode,
    },
  );

  assert.equal(missing, undefined, "an unresolvable node never yields an unfiltered frame");
});

test("R25: a rostered room operator (no direct node grant) is admitted to the SSE stream", async () => {
  // Room-B operator via ROSTER only: no resource grants, no node/room scope. The
  // old gate used hasResourceScope on the node target, which fails closed for a
  // roster-only operator, so they got an empty stream for channels they own. The
  // scoped-node resolver (mirroring /meters' scopedNodes) admits them.
  const access = createMeterRoomAccess({
    accessPolicyDecision: async () => undefined,
    hasResourceScope: async () => false,
    rosterRoomIds: async () => new Set(["room-b"]),
  });
  const rosterUser = user();
  // scopedNodes admits the node because the operator is rostered in room-b, which
  // owns channel 2 on this shared node.
  const resolveScopedNode = async (_u: CurrentUser, id: string) =>
    id === "node-1" ? sharedNode() : undefined;

  const visible = await resolveVisibleMeterFrame(rosterUser, frame(), {
    filterMeterFrame: access.filterMeterFrameForUser,
    resolveScopedNode,
  });

  // Admitted, and filtered to only the room-b channel they own.
  assert.deepEqual(
    visible?.levels.map((level) => level.channelIndex),
    [2],
    "a rostered operator receives their own channels, not an empty stream",
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

test("hasFullNodeAuthority: a room-scoped grant is NOT full-node authority", async () => {
  const access = roomAAccess(); // accessPolicyDecision -> undefined
  const roomAUser = user({ resourceGrants: [{ resourceId: "room-a", resourceType: "room" }] });

  assert.equal(await access.hasFullNodeAuthority(roomAUser, sharedNode()), false);
});

test("hasFullNodeAuthority: node/site/wildcard grants and owner confer it", async () => {
  const access = roomAAccess();

  assert.equal(
    await access.hasFullNodeAuthority(
      user({ resourceGrants: [{ resourceId: "node-1", resourceType: "node" }] }),
      sharedNode(),
    ),
    true,
  );
  assert.equal(
    await access.hasFullNodeAuthority(
      user({ resourceGrants: [{ resourceId: "HQ", resourceType: "site" }] }),
      sharedNode(),
    ),
    true,
  );
  assert.equal(
    await access.hasFullNodeAuthority(
      user({ resourceGrants: [{ resourceId: "*", resourceType: "*" }] }),
      sharedNode(),
    ),
    true,
  );
  assert.equal(await access.hasFullNodeAuthority(user({ roles: ["owner"] }), sharedNode()), true);
});

test("hasFullNodeAuthority: a node/site access-policy allow confers it; deny withholds it", async () => {
  const allow = createMeterRoomAccess({
    accessPolicyDecision: async () => ({ effect: "allow" }),
    hasResourceScope: async () => false,
    rosterRoomIds: async () => new Set<string>(),
  });
  assert.equal(await allow.hasFullNodeAuthority(user(), sharedNode()), true);

  // A deny withholds full authority even for a wildcard grant.
  const deny = createMeterRoomAccess({
    accessPolicyDecision: async () => ({ effect: "deny" }),
    hasResourceScope: async () => false,
    rosterRoomIds: async () => new Set<string>(),
  });
  assert.equal(
    await deny.hasFullNodeAuthority(
      user({ resourceGrants: [{ resourceId: "*", resourceType: "*" }] }),
      sharedNode(),
    ),
    false,
  );
});
