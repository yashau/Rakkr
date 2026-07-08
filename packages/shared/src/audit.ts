import { z } from "zod";

import { isoDateTimeSchema } from "./base.js";
import { permissionSchema, roleSchema } from "./rbac.js";

// Immutable audit record appended for every privileged action and denied
// attempt. `before`/`after` capture resource state diffs; `correlationIds` ties
// an event to runner runs, jobs, and sessions.
export const auditOutcomeSchema = z.enum(["allowed", "denied", "failed", "partial", "succeeded"]);
export const auditActorTypeSchema = z.enum(["node", "system", "user"]);

export const auditEventSchema = z.object({
  action: z.string().min(1),
  actor: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    roles: z.array(roleSchema),
    type: auditActorTypeSchema,
  }),
  actorContext: z.object({
    ipAddress: z.string().optional(),
    sessionId: z.string().optional(),
    userAgent: z.string().optional(),
  }),
  after: z.record(z.string(), z.unknown()).optional(),
  before: z.record(z.string(), z.unknown()).optional(),
  correlationIds: z.record(z.string(), z.string()).optional(),
  createdAt: isoDateTimeSchema,
  details: z.record(z.string(), z.unknown()),
  id: z.string().min(1),
  outcome: auditOutcomeSchema,
  permission: permissionSchema.optional(),
  reason: z.string().optional(),
  target: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().min(1),
  }),
});

export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;
