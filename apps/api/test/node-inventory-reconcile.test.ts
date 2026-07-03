import assert from "node:assert/strict";
import test from "node:test";
import type { AudioInterface } from "@rakkr/shared";
import type { NodeInterfaceInput } from "../src/node-store.js";

const { reconcileSeedInterfaces, reconcileSummaryChanged } =
  await import("../src/node-inventory-reconcile.js");

test("reconcile preserves operator labels while updating hardware facts", () => {
  const existing: AudioInterface[] = [
    {
      alias: "Studio A Console",
      backend: "alsa",
      channelCount: 2,
      channels: [
        { alias: "Host Mic", index: 1 },
        { alias: "Guest Mic", index: 2 },
      ],
      id: "iface-uuid-1",
      sampleRates: [48000],
      systemName: "X-USB USB Audio",
      systemRef: "hw:CARD=X32,DEV=0",
    },
  ];

  const { interfaces, summary } = reconcileSeedInterfaces(existing, [
    agentInterface({
      alias: "X-USB USB Audio",
      channelCount: 4,
      channels: [
        { alias: "Input 1", index: 1 },
        { alias: "Input 2", index: 2 },
        { alias: "Input 3", index: 3 },
        { alias: "Input 4", index: 4 },
      ],
      sampleRates: [44100, 48000],
      systemName: "X-USB USB Audio",
      systemRef: "hw:CARD=X32,DEV=0",
    }),
  ]);

  assert.equal(interfaces.length, 1);
  const [reconciled] = interfaces;
  // Stable id preserved so channel-map assignments keep resolving.
  assert.equal(reconciled.id, "iface-uuid-1");
  // Operator interface label preserved.
  assert.equal(reconciled.alias, "Studio A Console");
  // Agent hardware facts applied.
  assert.equal(reconciled.channelCount, 4);
  assert.deepEqual(reconciled.sampleRates, [44100, 48000]);
  // Operator channel aliases preserved; new channels filled from the agent.
  assert.deepEqual(
    reconciled.channels.map((channel) => channel.alias),
    ["Host Mic", "Guest Mic", "Input 3", "Input 4"],
  );
  assert.deepEqual(summary.updated, ["X-USB USB Audio"]);
  assert.equal(reconcileSummaryChanged(summary), true);
});

test("reconcile preserves per-channel room assignments and leaves new channels unassigned", () => {
  const existing: AudioInterface[] = [
    {
      alias: "X32 Console",
      backend: "alsa",
      channelCount: 2,
      channels: [
        { alias: "Chamber L", index: 1, roomId: "room-chamber" },
        { alias: "Chamber R", index: 2, roomId: "room-chamber" },
      ],
      id: "iface-uuid-1",
      sampleRates: [48000],
      systemName: "X-USB USB Audio",
      systemRef: "hw:CARD=X32,DEV=0",
    },
  ];

  const { interfaces } = reconcileSeedInterfaces(existing, [
    agentInterface({
      channelCount: 4,
      channels: [
        { alias: "Input 1", index: 1 },
        { alias: "Input 2", index: 2 },
        { alias: "Input 3", index: 3 },
        { alias: "Input 4", index: 4 },
      ],
      systemName: "X-USB USB Audio",
      systemRef: "hw:CARD=X32,DEV=0",
    }),
  ]);

  const [reconciled] = interfaces;
  // Operator room assignments survive re-inventory, matched on channel index.
  assert.equal(reconciled.channels[0].roomId, "room-chamber");
  assert.equal(reconciled.channels[1].roomId, "room-chamber");
  // Newly discovered channels start unassigned (inherit the node default room).
  assert.equal(reconciled.channels[2].roomId, undefined);
  assert.equal(reconciled.channels[3].roomId, undefined);
});

test("reconcile drops a vanished channel's room on shrink and re-grows it unassigned", () => {
  const existing: AudioInterface[] = [
    {
      alias: "X32 Console",
      backend: "alsa",
      channelCount: 4,
      channels: [
        { alias: "Keep", index: 1, roomId: "room-keep" },
        { alias: "Chan 2", index: 2 },
        { alias: "Doomed", index: 3, roomId: "room-doomed" },
        { alias: "Chan 4", index: 4 },
      ],
      id: "iface-uuid-1",
      sampleRates: [48000],
      systemName: "X-USB USB Audio",
      systemRef: "hw:CARD=X32,DEV=0",
    },
  ];

  // Shrink: the agent now reports only 2 channels (a device-enumeration change).
  const shrunk = reconcileSeedInterfaces(existing, [
    agentInterface({
      channelCount: 2,
      channels: [
        { alias: "Input 1", index: 1 },
        { alias: "Input 2", index: 2 },
      ],
      systemName: "X-USB USB Audio",
      systemRef: "hw:CARD=X32,DEV=0",
    }),
  ]).interfaces;

  const shrunkChannels = shrunk[0].channels;
  assert.deepEqual(
    shrunkChannels.map((channel) => channel.index),
    [1, 2],
    "vanished channels are dropped",
  );
  // The surviving assigned channel keeps its room; the vanished channel's room is gone.
  assert.equal(shrunkChannels[0].roomId, "room-keep");
  assert.ok(
    !shrunkChannels.some((channel) => channel.roomId === "room-doomed"),
    "the vanished channel's room assignment is dropped",
  );

  // Re-grow: the channel reappears — but its prior room assignment is NOT restored
  // (the agent owns hardware truth; a transient hiccup does not resurrect stale scope).
  const regrown = reconcileSeedInterfaces(shrunk, [
    agentInterface({
      channelCount: 4,
      channels: [
        { alias: "Input 1", index: 1 },
        { alias: "Input 2", index: 2 },
        { alias: "Input 3", index: 3 },
        { alias: "Input 4", index: 4 },
      ],
      systemName: "X-USB USB Audio",
      systemRef: "hw:CARD=X32,DEV=0",
    }),
  ]).interfaces;

  const regrownChannels = regrown[0].channels;
  assert.deepEqual(
    regrownChannels.map((channel) => channel.index),
    [1, 2, 3, 4],
  );
  assert.equal(
    regrownChannels[0].roomId,
    "room-keep",
    "surviving assignment persists across regrow",
  );
  assert.equal(
    regrownChannels[2].roomId,
    undefined,
    "the re-grown channel comes back unassigned, not with its stale room",
  );
});

test("reconcile flags interfaces the agent no longer reports as absent", () => {
  const existing: AudioInterface[] = [
    {
      alias: "Kept",
      backend: "alsa",
      channelCount: 2,
      channels: [],
      id: "iface-kept",
      sampleRates: [48000],
      systemName: "Kept",
      systemRef: "hw:CARD=KEEP,DEV=0",
    },
    {
      alias: "Removed",
      backend: "alsa",
      channelCount: 2,
      channels: [],
      id: "iface-removed",
      sampleRates: [48000],
      systemName: "Removed",
      systemRef: "hw:CARD=GONE,DEV=0",
    },
  ];

  const { interfaces, summary } = reconcileSeedInterfaces(existing, [
    agentInterface({
      alias: "Kept",
      systemName: "Kept",
      systemRef: "hw:CARD=KEEP,DEV=0",
    }),
  ]);

  const removed = interfaces.find((audioInterface) => audioInterface.id === "iface-removed");
  const kept = interfaces.find((audioInterface) => audioInterface.id === "iface-kept");

  // Absent device is flagged, not dropped — channel-map history survives.
  assert.equal(removed?.absent, true);
  assert.equal(kept?.absent, undefined);
  assert.deepEqual(summary.absent, ["Removed"]);
  assert.deepEqual(summary.unchanged, 1);
});

test("reconcile adds a brand-new interface and is a no-op on a repeat report", () => {
  const first = reconcileSeedInterfaces(
    [],
    [agentInterface({ systemName: "New Card", systemRef: "hw:CARD=NEW,DEV=0" })],
  );

  assert.deepEqual(first.summary.added, ["New Card"]);
  assert.equal(first.interfaces.length, 1);

  const second = reconcileSeedInterfaces(first.interfaces, [
    agentInterface({ systemName: "New Card", systemRef: "hw:CARD=NEW,DEV=0" }),
  ]);

  assert.equal(reconcileSummaryChanged(second.summary), false);
  assert.equal(second.summary.unchanged, 1);
});

test("reconcile reactivates a previously-absent interface that reappears", () => {
  const absent: AudioInterface[] = [
    {
      absent: true,
      alias: "Flaky USB",
      backend: "alsa",
      channelCount: 2,
      channels: [],
      id: "iface-flaky",
      sampleRates: [48000],
      systemName: "Flaky USB",
      systemRef: "hw:CARD=FLAKY,DEV=0",
    },
  ];

  const { interfaces, summary } = reconcileSeedInterfaces(absent, [
    agentInterface({ systemName: "Flaky USB", systemRef: "hw:CARD=FLAKY,DEV=0" }),
  ]);

  assert.equal(interfaces[0].id, "iface-flaky");
  assert.equal(interfaces[0].absent, undefined);
  assert.deepEqual(summary.reactivated, ["Flaky USB"]);
});

function agentInterface(input: Partial<NodeInterfaceInput> = {}): NodeInterfaceInput {
  return {
    alias: "Agent Interface",
    backend: "alsa",
    channelCount: 2,
    channels: [],
    sampleRates: [48000],
    systemName: "Agent Interface",
    systemRef: "hw:CARD=AGENT,DEV=0",
    ...input,
  };
}
