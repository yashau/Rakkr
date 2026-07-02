import { z } from "zod";

import { isoDateTimeSchema } from "./base.js";

// The light embedded form ({id,name}) carried in sessions/roster/schedule payloads.
export const accessGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export const accessGroupIdSchema = z.string().trim().min(1).max(120);
// Richer, management-facing group shapes. The light `accessGroupSchema` stays the
// embedded form; these add the metadata surfaced by the Access page's group
// management (never embedded per-user).
export const accessGroupSummarySchema = accessGroupSchema.extend({
  createdAt: isoDateTimeSchema.optional(),
  description: z.string().optional(),
  memberCount: z.number().int().nonnegative().default(0),
  updatedAt: isoDateTimeSchema.optional(),
});
export const accessGroupMemberSchema = z.object({
  email: z.string().email(),
  id: z.string().min(1),
  name: z.string().min(1),
});
export const accessGroupDetailSchema = accessGroupSummarySchema.extend({
  members: z.array(accessGroupMemberSchema).default([]),
});
// Create never accepts an id (the server derives an immutable slug from the name).
export const accessGroupCreateRequestSchema = z
  .object({
    description: z.string().trim().max(2000).optional(),
    memberIds: z.array(z.string().trim().min(1).max(160)).max(1024).default([]),
    name: z.string().trim().min(1).max(160),
  })
  .strict();
// Update covers name/description only (id is immutable); `description: null` clears it.
export const accessGroupUpdateRequestSchema = z
  .object({
    description: z.string().trim().max(2000).nullable().optional(),
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one group field is required");
export const accessGroupMembersReplaceRequestSchema = z
  .object({
    memberIds: z.array(z.string().trim().min(1).max(160)).max(1024),
  })
  .strict();

// Name-derived, URL-safe, immutable group id. Empty when the name has no usable
// characters (the caller falls back to a random id); collision suffixing (-2, -3…)
// is applied by the service against the existing id set.
export function accessGroupSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

export type AccessGroup = z.infer<typeof accessGroupSchema>;
export type AccessGroupId = z.infer<typeof accessGroupIdSchema>;
export type AccessGroupSummary = z.infer<typeof accessGroupSummarySchema>;
export type AccessGroupDetail = z.infer<typeof accessGroupDetailSchema>;
export type AccessGroupMember = z.infer<typeof accessGroupMemberSchema>;
export type AccessGroupCreateRequest = z.infer<typeof accessGroupCreateRequestSchema>;
export type AccessGroupUpdateRequest = z.infer<typeof accessGroupUpdateRequestSchema>;
export type AccessGroupMembersReplaceRequest = z.infer<
  typeof accessGroupMembersReplaceRequestSchema
>;
