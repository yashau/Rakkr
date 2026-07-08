import { z } from "zod";

// Day the operator console's schedule calendar starts its week on.
export const weekStartDaySchema = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);
export const controllerSettingsSchema = z.object({
  controllerName: z.string().trim().min(1).max(160),
  // Operator-chosen defaults that pre-fill the scheduling and ad-hoc recording
  // forms. `null` means "no default set" (the forms fall back to the built-in
  // profile/policy). One default per type keeps the "set as default" toggle
  // single-select without per-policy flags.
  defaultRecordingProfileId: z.string().trim().min(1).max(160).nullable().default(null),
  defaultRetentionPolicyId: z.string().trim().min(1).max(160).nullable().default(null),
  defaultUploadPolicyId: z.string().trim().min(1).max(160).nullable().default(null),
  defaultWatchdogPolicyId: z.string().trim().min(1).max(160).nullable().default(null),
  weekStartsOn: weekStartDaySchema.default("monday"),
});
export const controllerSettingsUpdateSchema = z
  .object({
    controllerName: z.string().trim().min(1).max(160).optional(),
    // Nullable so an operator can clear a default (send `null`); omitted keeps
    // the current value.
    defaultRecordingProfileId: z.string().trim().min(1).max(160).nullable().optional(),
    defaultRetentionPolicyId: z.string().trim().min(1).max(160).nullable().optional(),
    defaultUploadPolicyId: z.string().trim().min(1).max(160).nullable().optional(),
    defaultWatchdogPolicyId: z.string().trim().min(1).max(160).nullable().optional(),
    weekStartsOn: weekStartDaySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one controller setting is required");
export const defaultControllerSettings = controllerSettingsSchema.parse({
  controllerName: "Rakkr Controller",
  weekStartsOn: "monday",
});

export type ControllerSettings = z.infer<typeof controllerSettingsSchema>;
export type ControllerSettingsUpdate = z.infer<typeof controllerSettingsUpdateSchema>;
export type WeekStartDay = z.infer<typeof weekStartDaySchema>;
