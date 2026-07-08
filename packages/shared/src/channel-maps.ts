import { z } from "zod";

import { isoDateTimeSchema } from "./base.js";
import { channelModeSchema } from "./channels.js";

// A channel-map template maps captured source channels onto output channels, and
// is assignable to an interface or a whole node. Assignments carry history and
// can be staged as a plan before being applied.
export const templateAssignmentTargetSchema = z.enum(["interface", "node"]);

export const channelMapEntrySchema = z.object({
  included: z.boolean(),
  label: z.string().trim().min(1).max(160),
  outputChannelIndex: z.number().int().positive().optional(),
  sourceChannelIndex: z.number().int().positive(),
});
export const channelMapTemplateSchema = z.object({
  channelMode: channelModeSchema,
  entries: z.array(channelMapEntrySchema).min(1).max(128),
  id: z.string().min(1),
  name: z.string().min(1),
  promotedAt: isoDateTimeSchema.optional(),
  promotedFromTemplateId: z.string().min(1).optional(),
  revision: z.number().int().positive().default(1),
  tags: z.array(z.string().min(1)).default([]),
});
export const channelMapTemplateInputSchema = z.object({
  channelMode: channelModeSchema.default("mono_to_stereo_mix"),
  entries: z.array(channelMapEntrySchema).min(1).max(128),
  id: z.string().trim().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(80)).max(64).default([]),
});
export const channelMapTemplateUpdateSchema = z
  .object({
    channelMode: channelModeSchema.optional(),
    entries: z.array(channelMapEntrySchema).min(1).max(128).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one channel map field is required");
export const channelMapAssignmentHistorySchema = z.object({
  actorUserId: z.string().optional(),
  changedAt: isoDateTimeSchema,
  id: z.string().min(1),
  nextTemplateId: z.string().min(1),
  previousTemplateId: z.string().min(1).optional(),
  reason: z.enum(["assigned", "rolled_back"]),
});
export const channelMapTemplateAssignmentSchema = z.object({
  assignedAt: isoDateTimeSchema,
  history: z.array(channelMapAssignmentHistorySchema).default([]),
  id: z.string().min(1),
  targetId: z.string().min(1),
  targetType: templateAssignmentTargetSchema,
  templateId: z.string().min(1),
});
export const channelMapTemplateAssignmentInputSchema = z.object({
  targetId: z.string().trim().min(1).max(160),
  targetType: templateAssignmentTargetSchema,
  templateId: z.string().trim().min(1).max(160),
});
export const channelMapAssignmentTargetInputSchema = z.object({
  targetId: z.string().trim().min(1).max(160),
  targetType: templateAssignmentTargetSchema,
});
export const channelMapTemplateAssignmentBulkInputSchema = z.object({
  targets: z.array(channelMapAssignmentTargetInputSchema).min(1).max(128),
  templateId: z.string().trim().min(1).max(160),
});
export const channelMapAssignmentPlanStatusSchema = z.enum(["applied", "cancelled", "pending"]);
export const channelMapAssignmentPlanInputSchema = z.object({
  note: z.string().trim().max(500).optional(),
  targets: z.array(channelMapAssignmentTargetInputSchema).min(1).max(128),
  templateId: z.string().trim().min(1).max(160),
});
export const channelMapAssignmentPlanSchema = z.object({
  appliedAt: isoDateTimeSchema.optional(),
  appliedByUserId: z.string().optional(),
  cancelledAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  createdByUserId: z.string().optional(),
  id: z.string().min(1),
  note: z.string().optional(),
  status: channelMapAssignmentPlanStatusSchema,
  targets: z.array(channelMapAssignmentTargetInputSchema).min(1).max(128),
  templateId: z.string().min(1),
});
export const channelMapTemplateAssignmentRollbackInputSchema = z.object({
  targetId: z.string().trim().min(1).max(160),
  targetType: templateAssignmentTargetSchema,
});

export type ChannelMapAssignmentHistory = z.infer<typeof channelMapAssignmentHistorySchema>;
export type ChannelMapAssignmentPlan = z.infer<typeof channelMapAssignmentPlanSchema>;
export type ChannelMapAssignmentPlanInput = z.infer<typeof channelMapAssignmentPlanInputSchema>;
export type ChannelMapEntry = z.infer<typeof channelMapEntrySchema>;
export type ChannelMapTemplate = z.infer<typeof channelMapTemplateSchema>;
export type ChannelMapTemplateAssignment = z.infer<typeof channelMapTemplateAssignmentSchema>;
export type ChannelMapTemplateAssignmentInput = z.infer<
  typeof channelMapTemplateAssignmentInputSchema
>;
export type ChannelMapTemplateAssignmentBulkInput = z.infer<
  typeof channelMapTemplateAssignmentBulkInputSchema
>;
export type ChannelMapTemplateAssignmentRollbackInput = z.infer<
  typeof channelMapTemplateAssignmentRollbackInputSchema
>;
export type ChannelMapTemplateInput = z.infer<typeof channelMapTemplateInputSchema>;
export type ChannelMapTemplateUpdate = z.infer<typeof channelMapTemplateUpdateSchema>;
