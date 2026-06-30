import { z } from "zod";
import { captureChannelSelectionSchema, channelModeSchema } from "@rakkr/shared";

export const recordingStartRequestSchema = z
  .object({
    captureBackend: z.enum(["alsa", "jack", "pipewire"]).optional(),
    captureChannelSelection: captureChannelSelectionSchema.optional(),
    captureInterfaceId: z.string().trim().min(1).max(160).optional(),
    channelMode: channelModeSchema.optional(),
    folder: z.string().trim().min(1).max(240).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    nodeId: z.string().trim().min(1).max(160),
    recordingProfileId: z.string().trim().min(1).max(160).optional(),
    retentionPolicyId: z.string().trim().min(1).max(160).optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(32).optional(),
    uploadPolicyIds: z.array(z.string().trim().min(1).max(160)).max(16).optional(),
  })
  .strict();

export const recordingSelectedExportSchema = z
  .object({
    recordingIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();

// Upper bound used to project an ad-hoc capture window for channel-conflict
// detection (ad-hoc recordings are open-ended but bounded by this cap, matching
// the recorder job duration default).
export function adHocCaptureSeconds() {
  const parsed = Number(process.env.RAKKR_AGENT_CAPTURE_SECONDS);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3_600;
}
