import { z } from "zod";

import { isoDateTimeSchema, uploadProviderSchema, uploadQueueStatusSchema } from "./base.js";

export const uploadQueueItemSchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  cachePath: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  // Set when this item uploads one recording chunk as its own object. NULL =
  // legacy whole-recording item.
  chunkId: z.string().min(1).optional(),
  chunkIndex: z.number().int().positive().optional(),
  createdAt: isoDateTimeSchema,
  destinationId: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  id: z.string().min(1),
  lastError: z.string().min(1).optional(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: isoDateTimeSchema,
  pathOverride: z.string().min(1).optional(),
  provider: uploadProviderSchema,
  recordingId: z.string().min(1),
  status: uploadQueueStatusSchema,
  target: z.string().min(1).optional(),
  updatedAt: isoDateTimeSchema,
  uploadPolicyId: z.string().min(1).optional(),
});
export const uploadChecksumVerificationSchema = z.object({
  algorithm: z.literal("sha256"),
  expected: z.string().min(1),
  method: z.enum(["file_copy_sha256", "s3_checksum_sha256"]),
  observed: z.string().min(1).optional(),
  // `provider_declared` is the honest status for S3-compatible custom endpoints
  // that may ignore the trailing ChecksumSHA256; only real AWS S3 validates it,
  // which is `provider_validated`. `matched` is our own read-back byte compare.
  status: z.enum(["matched", "provider_validated", "provider_declared"]),
});
export const uploadQueueRunItemSchema = z.object({
  checksumVerification: uploadChecksumVerificationSchema.optional(),
  itemId: z.string().min(1),
  provider: uploadProviderSchema,
  reason: z.string().min(1).optional(),
  recordingId: z.string().min(1),
  status: uploadQueueStatusSchema,
});
export const uploadQueueRunSummarySchema = z.object({
  attempted: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(uploadQueueRunItemSchema),
  succeeded: z.number().int().nonnegative(),
});
export const uploadRunnerStatusSchema = z.object({
  batchSize: z.number().int().positive(),
  intervalSeconds: z.number().int().positive(),
  lastRunAt: isoDateTimeSchema.optional(),
  lastSummary: uploadQueueRunSummarySchema.optional(),
  running: z.boolean(),
  started: z.boolean(),
});

export const uploadPolicyTriggerSchema = z.enum(["manual", "on_recording_cached"]);
export const uploadPolicySchema = z.object({
  deleteCacheAfterUpload: z.boolean().default(false),
  destinationId: z.string().min(1).optional(),
  enabled: z.boolean(),
  id: z.string().min(1),
  maxAttempts: z.number().int().positive().max(100),
  name: z.string().min(1),
  pathOverride: z.string().min(1).max(500).optional(),
  trigger: uploadPolicyTriggerSchema,
  updatedAt: isoDateTimeSchema,
});
export const uploadPolicyInputSchema = z.object({
  deleteCacheAfterUpload: z.boolean().default(false),
  // Optional in the shared shape (the store is an internal seeding primitive),
  // but the operator create route requires it — every policy must target a real
  // destination or its recordings reconcile to `partial` (audit H3-3).
  destinationId: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().default(true),
  id: z.string().trim().min(1).max(160).optional(),
  maxAttempts: z.number().int().positive().max(100).default(5),
  name: z.string().trim().min(1).max(160),
  pathOverride: z.string().trim().min(1).max(500).optional(),
  trigger: uploadPolicyTriggerSchema.default("manual"),
});
export const uploadPolicyUpdateSchema = z
  .object({
    deleteCacheAfterUpload: z.boolean().optional(),
    destinationId: z.string().trim().min(1).max(160).optional(),
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().positive().max(100).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    pathOverride: z.string().trim().min(1).max(500).optional(),
    trigger: uploadPolicyTriggerSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one upload policy field is required");

export const defaultStubUploadPolicy = {
  deleteCacheAfterUpload: false,
  enabled: true,
  id: "upload-policy-stub",
  maxAttempts: 5,
  name: "Stub Upload Queue",
  trigger: "manual",
  updatedAt: "1970-01-01T00:00:00.000Z",
} satisfies UploadPolicy;

export type UploadChecksumVerification = z.infer<typeof uploadChecksumVerificationSchema>;
export type UploadPolicy = z.infer<typeof uploadPolicySchema>;
export type UploadPolicyInput = z.infer<typeof uploadPolicyInputSchema>;
export type UploadPolicyTrigger = z.infer<typeof uploadPolicyTriggerSchema>;
export type UploadPolicyUpdate = z.infer<typeof uploadPolicyUpdateSchema>;
export type UploadQueueItem = z.infer<typeof uploadQueueItemSchema>;
export type UploadQueueRunItem = z.infer<typeof uploadQueueRunItemSchema>;
export type UploadQueueRunSummary = z.infer<typeof uploadQueueRunSummarySchema>;
export type UploadRunnerStatus = z.infer<typeof uploadRunnerStatusSchema>;
