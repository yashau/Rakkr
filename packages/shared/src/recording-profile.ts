import { z } from "zod";

import { channelModeSchema } from "./channels.js";
import { recordingEnhancementSchema } from "./enhancement.js";

export const recordingProfileSchema = z.object({
  // This schema also parses persisted rows (recordingProfileFromRow), so it
  // stays permissive for any previously-stored value — the 512 kbps input
  // ceiling lives on recordingProfileUpdateSchema / the create route, not here
  // (a `.max` here would reject a legacy over-cap profile row on read).
  bitrateKbps: z.number().int().positive(),
  channelMode: channelModeSchema,
  // Length of each recording chunk in seconds. When set, the recording is
  // captured continuously and emitted as sequential chunk files that transfer
  // and upload as they close. Supersedes the deprecated `maxTrackSeconds`; read
  // both through `effectiveChunkSeconds`.
  chunkSeconds: z.number().int().positive().max(604_800).optional(),
  codec: z.enum(["mp3", "flac", "wav"]),
  enhancement: recordingEnhancementSchema.optional(),
  id: z.string().min(1),
  /** @deprecated superseded by `chunkSeconds`; retained one release for backfill. */
  maxTrackSeconds: z.number().int().positive().max(604_800).optional(),
  name: z.string().min(1),
  silenceDetectionEnabled: z.boolean(),
  silenceSkipEnabled: z.boolean(),
  vbr: z.boolean(),
});
// Bounded, all-optional field set shared by the PATCH update schema and the
// create schema (settings-routes derives create as `.required({ name: true })`).
// Input ceilings (varchar(160) name, 512 kbps, 604_800s chunks) live here — NOT
// on recordingProfileSchema, which stays permissive to parse legacy stored rows.
// One definition keeps create and update from drifting apart.
export const recordingProfileWritableSchema = z.object({
  bitrateKbps: z.number().int().positive().max(512).optional(),
  channelMode: channelModeSchema.optional(),
  chunkSeconds: z.number().int().positive().max(604_800).optional(),
  codec: z.enum(["mp3", "flac", "wav"]).optional(),
  enhancement: recordingEnhancementSchema.optional(),
  maxTrackSeconds: z.number().int().positive().max(604_800).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  silenceDetectionEnabled: z.boolean().optional(),
  silenceSkipEnabled: z.boolean().optional(),
  vbr: z.boolean().optional(),
});
export const recordingProfileUpdateSchema = recordingProfileWritableSchema
  .extend({
    // PATCH may null these to clear a configured chunk length; create cannot
    // (create derives from the base writable shape, where they stay unset-only).
    chunkSeconds: z.number().int().positive().max(604_800).nullable().optional(),
    maxTrackSeconds: z.number().int().positive().max(604_800).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one profile field is required");

// Resolve the active chunk length for a profile, preferring the new
// `chunkSeconds` knob and falling back to the deprecated `maxTrackSeconds`.
// Returns undefined when neither is set (recording stays a single file).
export function effectiveChunkSeconds(profile: RecordingProfile | undefined): number | undefined {
  const value = profile?.chunkSeconds ?? profile?.maxTrackSeconds ?? undefined;
  return typeof value === "number" && value > 0 ? value : undefined;
}

export type RecordingProfile = z.infer<typeof recordingProfileSchema>;
export type RecordingProfileUpdate = z.infer<typeof recordingProfileUpdateSchema>;
