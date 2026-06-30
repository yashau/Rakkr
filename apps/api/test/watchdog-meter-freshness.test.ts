import assert from "node:assert/strict";
import test from "node:test";
import type { MeterFrame } from "@rakkr/shared";
import {
  meterFrameIsFresh,
  watchdogMeterFrame,
  watchdogMeterMaxAgeSeconds,
} from "../src/api-runners.js";
import type { MeterFrameStore, StoredMeterFrame } from "../src/meter-store.js";

const NODE_ID = "node_watchdog_freshness";

test("meterFrameIsFresh accepts recent frames and rejects stale ones", () => {
  const now = new Date("2026-06-18T12:00:00.000Z");
  const maxAgeSeconds = watchdogMeterMaxAgeSeconds();

  const withinBound = new Date(now.getTime() - (maxAgeSeconds - 1) * 1_000).toISOString();
  const onBound = new Date(now.getTime() - maxAgeSeconds * 1_000).toISOString();
  const beyondBound = new Date(now.getTime() - (maxAgeSeconds + 1) * 1_000).toISOString();
  const slightlyAhead = new Date(now.getTime() + 5_000).toISOString();

  assert.equal(meterFrameIsFresh(withinBound, now), true);
  assert.equal(meterFrameIsFresh(onBound, now), true);
  assert.equal(meterFrameIsFresh(beyondBound, now), false);
  // A frame stamped a few seconds ahead of the controller clock is still live.
  assert.equal(meterFrameIsFresh(slightlyAhead, now), true);
  assert.equal(meterFrameIsFresh("not-a-date", now), false);
});

test("watchdogMeterFrame drops a stale frame so the watchdog fails closed", async () => {
  const now = new Date("2026-06-18T12:00:00.000Z");
  // A perfectly healthy speech frame — but its stream died ten minutes ago.
  const healthyButStale = healthyFrame();
  const store = staticMeterStore({
    frame: healthyButStale,
    receivedAt: new Date(now.getTime() - 600_000).toISOString(),
  });

  const frame = await watchdogMeterFrame(store, NODE_ID, now);

  // Pre-fix this returned `healthyButStale`, so the watchdog kept re-reading a
  // dead meter stream as healthy. It must now be treated as missing.
  assert.equal(frame, undefined);
});

test("watchdogMeterFrame returns a fresh frame unchanged", async () => {
  const now = new Date("2026-06-18T12:00:00.000Z");
  const live = healthyFrame();
  const store = staticMeterStore({
    frame: live,
    receivedAt: new Date(now.getTime() - 1_000).toISOString(),
  });

  const frame = await watchdogMeterFrame(store, NODE_ID, now);

  assert.equal(frame, live);
});

function healthyFrame(): MeterFrame {
  return {
    capturedAt: "2026-06-18T11:50:00.000Z",
    interfaceId: "iface_freshness",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Input 1",
        peakDbfs: -8,
        quality: {
          crestFactorDb: 14,
          noiseScore: 0.18,
          speechLike: true,
          speechScore: 0.84,
          zeroCrossingRate: 0.11,
        },
        rmsDbfs: -21,
      },
    ],
    nodeId: NODE_ID,
  };
}

function staticMeterStore(stored: StoredMeterFrame): MeterFrameStore {
  return {
    async history() {
      return [stored.frame];
    },
    async latest() {
      return stored.frame;
    },
    async latestStored() {
      return stored;
    },
    async save() {
      return stored;
    },
  };
}
