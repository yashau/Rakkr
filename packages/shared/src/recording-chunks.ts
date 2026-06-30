import { z } from "zod";

import { isoDateTimeSchema, uploadProviderSchema, uploadQueueStatusSchema } from "./base.js";

export const recordingChunkStatusSchema = z.enum([
  "capturing",
  "cached",
  "uploading",
  "uploaded",
  "partial",
  "failed",
]);
// Per-destination upload state attached to a chunk for at-a-glance display.
export const chunkUploadSummarySchema = z.object({
  attemptCount: z.number().int().nonnegative().optional(),
  destinationId: z.string().min(1).optional(),
  lastError: z.string().min(1).optional(),
  provider: uploadProviderSchema,
  status: uploadQueueStatusSchema,
  uploadPolicyId: z.string().min(1).optional(),
});
// One time-based segment of a recording. Many chunks roll up to one recording +
// one job; `index` is 1-based, `total` is known only once capture stops.
export const recordingChunkSchema = z.object({
  cachedAt: isoDateTimeSchema.optional(),
  cachePath: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  createdAt: isoDateTimeSchema,
  durationSeconds: z.number().int().nonnegative(),
  enhancedCachePath: z.string().min(1).optional(),
  id: z.string().min(1),
  index: z.number().int().positive(),
  jobId: z.string().min(1),
  offsetSeconds: z.number().int().nonnegative(),
  rawCachePath: z.string().min(1).optional(),
  recordingId: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  status: recordingChunkStatusSchema,
  total: z.number().int().positive().optional(),
  uploads: z.array(chunkUploadSummarySchema).optional(),
});

export type ChunkUploadSummary = z.infer<typeof chunkUploadSummarySchema>;
export type RecordingChunk = z.infer<typeof recordingChunkSchema>;
export type RecordingChunkStatus = z.infer<typeof recordingChunkStatusSchema>;
