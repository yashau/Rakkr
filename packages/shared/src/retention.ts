import { z } from "zod";

import { isoDateTimeSchema } from "./base.js";

export const retentionPolicyScopeSchema = z.enum(["controller_cache", "recorder_cache"]);
export const retentionPolicyActionSchema = z.enum(["keep", "delete_cache"]);
export const retentionPolicySchema = z.object({
  action: retentionPolicyActionSchema,
  deleteOnlyAfterUploaded: z.boolean(),
  enabled: z.boolean(),
  id: z.string().min(1),
  maxAgeDays: z.number().int().positive().max(3650).nullable(),
  maxBytes: z.number().int().positive().max(1_000_000_000_000_000).nullable(),
  minFreeDiskPercent: z.number().int().min(0).max(95).nullable(),
  name: z.string().min(1),
  preserveTagged: z.boolean(),
  scope: retentionPolicyScopeSchema,
  updatedAt: isoDateTimeSchema,
});
export const retentionPolicyInputSchema = z.object({
  action: retentionPolicyActionSchema.default("keep"),
  deleteOnlyAfterUploaded: z.boolean().default(true),
  enabled: z.boolean().default(true),
  id: z.string().trim().min(1).max(160).optional(),
  maxAgeDays: z.number().int().positive().max(3650).nullable().default(null),
  maxBytes: z.number().int().positive().max(1_000_000_000_000_000).nullable().default(null),
  minFreeDiskPercent: z.number().int().min(0).max(95).nullable().default(null),
  name: z.string().trim().min(1).max(160),
  preserveTagged: z.boolean().default(true),
  scope: retentionPolicyScopeSchema.default("controller_cache"),
});
export const retentionPolicyUpdateSchema = z
  .object({
    action: retentionPolicyActionSchema.optional(),
    deleteOnlyAfterUploaded: z.boolean().optional(),
    enabled: z.boolean().optional(),
    maxAgeDays: z.number().int().positive().max(3650).nullable().optional(),
    maxBytes: z.number().int().positive().max(1_000_000_000_000_000).nullable().optional(),
    minFreeDiskPercent: z.number().int().min(0).max(95).nullable().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    preserveTagged: z.boolean().optional(),
    scope: retentionPolicyScopeSchema.optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one retention policy field is required",
  );

export const defaultKeepControllerCacheRetentionPolicy = {
  action: "keep",
  deleteOnlyAfterUploaded: true,
  enabled: true,
  id: "retention-keep-controller-cache",
  maxAgeDays: null,
  maxBytes: null,
  minFreeDiskPercent: null,
  name: "Keep Controller Cache",
  preserveTagged: true,
  scope: "controller_cache",
  updatedAt: "1970-01-01T00:00:00.000Z",
} satisfies RetentionPolicy;

export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type RetentionPolicyAction = z.infer<typeof retentionPolicyActionSchema>;
export type RetentionPolicyInput = z.infer<typeof retentionPolicyInputSchema>;
export type RetentionPolicyScope = z.infer<typeof retentionPolicyScopeSchema>;
export type RetentionPolicyUpdate = z.infer<typeof retentionPolicyUpdateSchema>;
