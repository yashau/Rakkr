import { z } from "zod";

import type { RecorderNode, RecordingSummary } from "./index.js";
import { roomCapabilitySchema } from "./room-capabilities.js";

// First-class room. `id` is the stable RBAC scope target; (site, name) is unique.
export const roomSchema = z.object({
  building: z.string().trim().max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  floor: z.string().trim().max(160).optional(),
  id: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  nodeCount: z.number().int().nonnegative().optional(),
  notes: z.string().trim().max(4000).optional(),
  site: z.string().trim().min(1).max(160),
});
export const roomInputSchema = roomSchema.omit({ id: true, nodeCount: true }).extend({
  id: z.string().trim().min(1).max(160).optional(),
});
export const roomUpdateSchema = z
  .object({
    building: z.string().trim().max(160).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    floor: z.string().trim().max(160).nullable().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    site: z.string().trim().min(1).max(160).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one room field is required");

export const roomRosterSubjectTypeSchema = z.enum(["user", "group"]);
export const roomRosterSourceSchema = z.enum(["manual", "calendar"]);

// A single roster entry as returned to operators: a subject with its effective
// per-action capabilities. `source` distinguishes manual grants from
// calendar-derived (meeting assignment) grants.
export const roomRosterEntrySchema = z.object({
  capabilities: z.array(roomCapabilitySchema),
  source: roomRosterSourceSchema,
  sourceScheduleId: z.string().min(1).optional(),
  subjectId: z.string().min(1),
  subjectName: z.string().min(1).optional(),
  subjectType: roomRosterSubjectTypeSchema,
});

// Payload for replacing a room's MANUAL roster (calendar-derived entries are
// reconciled from schedules and are not edited here). Empty capabilities removes
// the subject.
export const roomRosterUpdateSchema = z.object({
  entries: z
    .array(
      z.object({
        capabilities: z.array(roomCapabilitySchema).max(7),
        subjectId: z.string().trim().min(1).max(160),
        subjectType: roomRosterSubjectTypeSchema,
      }),
    )
    .max(500),
});

// Aggregated room-detail payload for the Room page. Server-produced, so it is a
// plain type (not a validated schema) and uses type-only imports to avoid a
// module cycle with the node/recording schemas defined in index.ts.
export interface RoomUpcomingOccurrence {
  recordingEndAt?: string;
  recordingStartAt: string;
  scheduleId: string;
  scheduleName: string;
  scheduledByName?: string;
}

export interface RoomOverview {
  nodes: RecorderNode[];
  recentRecordings: RecordingSummary[];
  room: Room;
  upcoming: RoomUpcomingOccurrence[];
}

export type Room = z.infer<typeof roomSchema>;
export type RoomInput = z.infer<typeof roomInputSchema>;
export type RoomUpdate = z.infer<typeof roomUpdateSchema>;
export type RoomRosterEntry = z.infer<typeof roomRosterEntrySchema>;
export type RoomRosterSubjectType = z.infer<typeof roomRosterSubjectTypeSchema>;
export type RoomRosterUpdate = z.infer<typeof roomRosterUpdateSchema>;
