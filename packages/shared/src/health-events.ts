import { z } from "zod";

import { healthSeveritySchema, isoDateTimeSchema } from "./base.js";

export const healthEventStatusSchema = z.enum(["open", "acknowledged", "suppressed", "resolved"]);

export const healthEventSchema = z.object({
  acknowledgedAt: isoDateTimeSchema.nullable(),
  acknowledgedBy: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
  id: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  openedAt: isoDateTimeSchema,
  recordingId: z.string().optional(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedBy: z.string().optional(),
  scheduleId: z.string().optional(),
  severity: healthSeveritySchema,
  status: healthEventStatusSchema,
  suppressedAt: isoDateTimeSchema.nullable(),
  suppressedBy: z.string().optional(),
  suppressedUntil: isoDateTimeSchema.nullable(),
  type: z.string().min(1),
});

export type HealthEvent = z.infer<typeof healthEventSchema>;
export type HealthEventStatus = z.infer<typeof healthEventStatusSchema>;
