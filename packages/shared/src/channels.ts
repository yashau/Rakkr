import { z } from "zod";

export const channelModeSchema = z.enum(["mono", "stereo", "mono_to_stereo_mix", "multichannel"]);

// An explicit, ordered set of 1-based source channel indices selected from an
// audio interface for a single recording/schedule. Order is meaningful (e.g.
// stereo: [left, right]); duplicates are rejected. An empty/absent selection
// means "capture the whole interface" (legacy behavior).
export const captureChannelSelectionSchema = z
  .array(z.number().int().positive().max(512))
  .min(1)
  .max(512)
  .superRefine((channels, ctx) => {
    if (new Set(channels).size !== channels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Channel selection must not list a channel more than once",
      });
    }
  });

// Minimum number of selected channels each output mode requires. Used by the
// controller to validate a selection against the chosen mode before building
// the job channel map.
export const channelModeMinChannels: Record<z.infer<typeof channelModeSchema>, number> = {
  mono: 1,
  mono_to_stereo_mix: 1,
  multichannel: 1,
  stereo: 2,
};

// Maximum selected channels a mode accepts (stereo is a fixed L/R pair); null
// means no upper bound beyond the schema cap.
export const channelModeMaxChannels: Record<z.infer<typeof channelModeSchema>, number | null> = {
  mono: null,
  mono_to_stereo_mix: null,
  multichannel: null,
  stereo: 2,
};

export type CaptureChannelSelection = z.infer<typeof captureChannelSelectionSchema>;
export type ChannelMode = z.infer<typeof channelModeSchema>;
