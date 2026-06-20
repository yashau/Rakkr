import assert from "node:assert/strict";
import test from "node:test";
import type { AudioLevel } from "@rakkr/shared";

import { dbfsToPercent, meterBankSummary, meterChannelView } from "./meter-helpers";

test("meter percent clamps dBFS values to the visible scale", () => {
  assert.equal(dbfsToPercent(-90), 0);
  assert.equal(dbfsToPercent(-72), 0);
  assert.equal(dbfsToPercent(-3), 100);
  assert.equal(dbfsToPercent(12), 100);
});

test("meter channel view exposes level voice and clipping state", () => {
  assert.deepEqual(
    meterChannelView(
      level({
        clipping: true,
        peakDbfs: -1.2,
        quality: {
          channelCorrelation: {
            peerChannelIndex: 2,
            phase: "same",
            score: 0.99,
          },
          crestFactorDb: 11.8,
          estimatedSnrDb: 24.6,
          humScore: 0.07,
          intelligibilityScore: 0.74,
          noiseScore: 0.18,
          speechLike: true,
          speechScore: 0.91,
          staticScore: 0.03,
          zeroCrossingRate: 0.12,
        },
        rmsDbfs: -18,
      }),
    ),
    {
      clipping: true,
      correlationLabel: "ch 2 same",
      correlationPercent: 99,
      humPercent: 7,
      intelligibilityPercent: 74,
      noisePercent: 18,
      peakDbfs: "-1.2 dBFS",
      peakPercent: 100,
      rmsDbfs: "-18.0 dBFS",
      rmsPercent: 78.26086956521739,
      snrDb: "24.6 dB",
      speechLabel: "speech",
      speechPercent: 91,
      staticPercent: 3,
      toneClass: "from-amber-400 via-orange-500 to-red-500",
    },
  );
});

test("meter bank summary reports empty and populated channel groups", () => {
  assert.deepEqual(meterBankSummary([]), {
    clippingChannels: 0,
    maxPeakDbfs: "n/a",
    maxRmsDbfs: "n/a",
    speechChannels: 0,
  });
  assert.deepEqual(
    meterBankSummary([
      level({ clipping: false, peakDbfs: -10, rmsDbfs: -25 }),
      level({
        channelIndex: 2,
        clipping: true,
        peakDbfs: -0.5,
        quality: {
          crestFactorDb: 9,
          estimatedSnrDb: 18,
          humScore: 0.04,
          intelligibilityScore: 0.68,
          noiseScore: 0.2,
          speechLike: true,
          speechScore: 0.8,
          staticScore: 0.1,
          zeroCrossingRate: 0.1,
        },
        rmsDbfs: -12,
      }),
    ]),
    {
      clippingChannels: 1,
      maxPeakDbfs: "-0.5 dBFS",
      maxRmsDbfs: "-12.0 dBFS",
      speechChannels: 1,
    },
  );
});

function level(input: Partial<AudioLevel> = {}): AudioLevel {
  return {
    channelIndex: 1,
    clipping: false,
    label: "Lectern",
    peakDbfs: -12,
    rmsDbfs: -24,
    ...input,
  };
}
