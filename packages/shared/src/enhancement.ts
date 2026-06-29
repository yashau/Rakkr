import { z } from "zod";

import type { RecordingProfile } from "./index.js";

export const enhancementDenoiseEngineSchema = z.enum(["rnnoise", "deepfilternet3"]);

// Voice-enhancement chain stored on a recording profile (the preset/template).
// Every stage is independently toggleable with configurable parameters; the agent
// applies enabled stages in a fixed order (highpass -> denoise -> deesser ->
// compressor -> loudnorm -> gate) to produce the enhanced rendition, always
// alongside the untouched raw audio when keepRaw is set.
export const recordingEnhancementSchema = z.object({
  keepRaw: z.boolean().default(true),
  denoise: z
    .object({
      enabled: z.boolean().default(true),
      engine: enhancementDenoiseEngineSchema.default("deepfilternet3"),
    })
    .default({ enabled: true, engine: "deepfilternet3" }),
  highpass: z
    .object({
      enabled: z.boolean().default(true),
      hz: z.number().int().min(20).max(500).default(80),
    })
    .default({ enabled: true, hz: 80 }),
  lowpass: z
    .object({
      enabled: z.boolean().default(false),
      hz: z.number().int().min(2000).max(20_000).default(12_000),
    })
    .default({ enabled: false, hz: 12_000 }),
  deesser: z
    .object({
      enabled: z.boolean().default(false),
      intensity: z.number().min(0).max(1).default(0.1),
    })
    .default({ enabled: false, intensity: 0.1 }),
  compressor: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  loudnorm: z
    .object({
      enabled: z.boolean().default(true),
      targetI: z.number().min(-70).max(-5).default(-16),
      truePeak: z.number().min(-9).max(0).default(-1.5),
      lra: z.number().min(1).max(50).default(11),
    })
    .default({ enabled: true, targetI: -16, truePeak: -1.5, lra: 11 }),
  gate: z
    .object({
      enabled: z.boolean().default(false),
      thresholdDb: z.number().min(-80).max(0).default(-40),
    })
    .default({ enabled: false, thresholdDb: -40 }),
});

// Fully-defaulted enhancement chain, for editors and code paths that need a
// starting value when a profile has none.
export const defaultRecordingEnhancement = recordingEnhancementSchema.parse({});

export type RecordingEnhancement = z.infer<typeof recordingEnhancementSchema>;

// The built-in voice profile, bundling the default enhancement chain.
export const defaultVoiceRecordingProfile = {
  bitrateKbps: 128,
  channelMode: "mono_to_stereo_mix",
  codec: "mp3",
  enhancement: defaultRecordingEnhancement,
  id: "voice-mp3-vbr",
  name: "Voice MP3 VBR",
  silenceDetectionEnabled: false,
  silenceSkipEnabled: false,
  vbr: true,
} satisfies RecordingProfile;
