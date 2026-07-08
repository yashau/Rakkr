import { z } from "zod";

import { audioCaptureBackendSchema, isoDateTimeSchema } from "./base.js";
import { channelMapEntrySchema, templateAssignmentTargetSchema } from "./channel-maps.js";
import { captureChannelSelectionSchema, channelModeSchema } from "./channels.js";
import { recordingEnhancementSchema } from "./enhancement.js";
import { recordingChunkSchema } from "./recording-chunks.js";

export const recordingSourceSchema = z.enum(["ad_hoc", "schedule"]);
export const recordingStatusSchema = z.enum([
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
  "partial",
]);
export const recordingJobStatusSchema = z.enum([
  "queued",
  "running",
  "stop_requested",
  "cancelled",
  "completed",
  "failed",
]);

export const recordingSummarySchema = z.object({
  cached: z.boolean(),
  cachePath: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  chunks: z.array(recordingChunkSchema).optional(),
  chunkSeconds: z.number().int().positive().optional(),
  chunkTotal: z.number().int().positive().optional(),
  durationSeconds: z.number().int().nonnegative(),
  enhancedCachePath: z.string().min(1).optional(),
  rawCachePath: z.string().min(1).optional(),
  folder: z.string().min(1),
  healthStatus: z.enum(["healthy", "warning", "critical", "unknown"]),
  id: z.string().min(1),
  name: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
  recordedAt: isoDateTimeSchema,
  recordingProfileId: z.string().min(1).optional(),
  retentionPolicyId: z.string().min(1).optional(),
  // Room that owns this recording, captured at create time from the selected
  // channels' room. Persisted, not derived, so a later channel reassignment does
  // not retroactively move a completed recording.
  roomId: z.string().min(1).optional(),
  scheduleId: z.string().min(1).optional(),
  source: recordingSourceSchema,
  status: recordingStatusSchema,
  tags: z.array(z.string().min(1)),
  transcriptSnippets: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  trackGroupId: z.string().min(1).optional(),
  trackIndex: z.number().int().positive().optional(),
  trackTotal: z.number().int().positive().optional(),
  uploadPolicyIds: z.array(z.string().min(1)).optional(),
  watchdogPolicyId: z.string().min(1).optional(),
  waveformPreview: z
    .object({
      channelCount: z.number().int().positive(),
      generatedAt: isoDateTimeSchema,
      peaks: z.array(z.number().min(0).max(1)).min(1).max(256),
      sampleCount: z.number().int().positive(),
      sampleRate: z.number().int().positive(),
      source: z.enum(["ffmpeg_decoded_peak", "wav_s16le_peak"]),
    })
    .optional(),
});
export const recordingJobChannelMapSchema = z.object({
  assignmentId: z.string().min(1),
  channelMode: channelModeSchema,
  entries: z.array(channelMapEntrySchema).min(1).max(128),
  sourceChannels: z.number().int().positive(),
  targetId: z.string().min(1),
  targetType: templateAssignmentTargetSchema,
  templateId: z.string().min(1),
  templateName: z.string().min(1),
});
export const recordingJobSchema = z.object({
  claimedBy: z.string().min(1).optional(),
  command: z.object({
    captureBackend: audioCaptureBackendSchema.optional(),
    captureChannels: z.number().int().positive(),
    // Resolved 1-based source channels this job owns on the interface. Absent =
    // whole interface (legacy). Drives both the channel map and the controller's
    // per-channel conflict detection.
    captureChannelSelection: captureChannelSelectionSchema.optional(),
    captureDevice: z.string().min(1),
    captureFormat: z.string().min(1),
    // Jobs sharing an interface + capture window carry the same group id so the
    // agent can capture the device once and split it into per-job renditions.
    captureGroupId: z.string().min(1).optional(),
    captureInterfaceId: z.string().min(1).optional(),
    captureSampleRate: z.number().int().positive(),
    channelMap: recordingJobChannelMapSchema.optional(),
    chunkSeconds: z.number().int().positive().optional(),
    durationSeconds: z.number().int().positive(),
    enhancement: recordingEnhancementSchema.optional(),
    outputBitrateKbps: z.number().int().positive().optional(),
    outputCodec: z.enum(["mp3", "flac", "wav"]).optional(),
    outputFileName: z.string().min(1),
    outputVbr: z.boolean().optional(),
    recorderCacheRetention: z
      .object({
        deleteAfterUpload: z.boolean(),
        maxAgeDays: z.number().int().positive().nullable().optional(),
        maxBytes: z.number().int().positive().nullable().optional(),
        minFreeDiskPercent: z.number().int().min(0).max(95).nullable().optional(),
        policyId: z.string().min(1),
      })
      .optional(),
    trackGroupId: z.string().min(1).optional(),
    trackIndex: z.number().int().positive().optional(),
    trackTotal: z.number().int().positive().optional(),
    type: z.literal("alsa_capture"),
  }),
  chunks: z.array(recordingChunkSchema).optional(),
  chunkTotal: z.number().int().positive().optional(),
  completedAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  failureReason: z.string().optional(),
  id: z.string().min(1),
  lastHeartbeatAt: isoDateTimeSchema.optional(),
  leaseExpiresAt: isoDateTimeSchema.optional(),
  nodeId: z.string().min(1),
  recordingId: z.string().min(1),
  startedAt: isoDateTimeSchema.optional(),
  status: recordingJobStatusSchema,
  stopRequestedAt: isoDateTimeSchema.optional(),
});

export type RecordingJob = z.infer<typeof recordingJobSchema>;
export type RecordingJobChannelMap = z.infer<typeof recordingJobChannelMapSchema>;
export type RecordingJobStatus = z.infer<typeof recordingJobStatusSchema>;
export type RecordingSummary = z.infer<typeof recordingSummarySchema>;
export type RecordingWaveformPreview = NonNullable<RecordingSummary["waveformPreview"]>;
