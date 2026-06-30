import assert from "node:assert/strict";
import test from "node:test";
import { recordingEnhancementSchema, type RecordingProfile } from "@rakkr/shared";

import {
  recordingProfileFromRow,
  recordingProfileToRow,
} from "../src/recording-profile-settings.js";

// A chain that differs from defaultRecordingEnhancement in every stage, so a
// faithful round-trip must carry real values, not coincidental defaults.
const customEnhancement = recordingEnhancementSchema.parse({
  keepRaw: false,
  denoise: { enabled: true, engine: "rnnoise" },
  highpass: { enabled: true, hz: 120 },
  lowpass: { enabled: true, hz: 9_000 },
  deesser: { enabled: true, intensity: 0.4 },
  compressor: { enabled: true },
  loudnorm: { enabled: true, targetI: -18, truePeak: -2, lra: 7 },
  gate: { enabled: true, thresholdDb: -50 },
});

function selectRow(profile: RecordingProfile) {
  // recordingProfileToRow produces the insert shape; the select shape adds the
  // DB-managed createdAt, which the reader does not consult.
  return {
    ...recordingProfileToRow(profile),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  } as Parameters<typeof recordingProfileFromRow>[0];
}

test("recording profile enhancement survives the Postgres row round-trip", () => {
  const profile: RecordingProfile = {
    bitrateKbps: 160,
    channelMode: "mono_to_stereo_mix",
    codec: "mp3",
    enhancement: customEnhancement,
    id: "profile-with-enhancement",
    name: "Enhanced Voice",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: true,
  };

  const row = recordingProfileToRow(profile);

  // Write side: the chain must land in the jsonb settings column.
  assert.deepEqual((row.settings as Record<string, unknown>).enhancement, customEnhancement);

  // Read side: reconstructing the profile must restore the full chain.
  const restored = recordingProfileFromRow(selectRow(profile));
  assert.deepEqual(restored.enhancement, customEnhancement);
});

test("recording profile without enhancement does not fabricate one", () => {
  const profile: RecordingProfile = {
    bitrateKbps: 128,
    channelMode: "mono_to_stereo_mix",
    codec: "flac",
    id: "profile-without-enhancement",
    name: "Raw Capture",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: false,
  };

  const row = recordingProfileToRow(profile);
  assert.equal((row.settings as Record<string, unknown>).enhancement, undefined);

  const restored = recordingProfileFromRow(selectRow(profile));
  assert.equal(restored.enhancement, undefined);
});
