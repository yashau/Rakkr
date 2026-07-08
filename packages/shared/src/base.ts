import { z } from "zod";

// Shared primitive schemas with no other dependencies, kept in a leaf module so
// other leaf schema modules (e.g. recording-chunks) can reuse them without an
// import cycle through the main index.

// A parseable ISO 8601 date-time. The `.refine` rejects non-date strings that
// would otherwise pass `.min(1)` and then throw `RangeError` at
// `new Date(value).toISOString()` deeper in the request (500 instead of 400).
export const isoDateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be a parseable ISO 8601 date-time",
  });

// A valid IANA time-zone name. The `.refine` rejects strings that pass
// `.min(1)` but then throw `RangeError: Invalid time zone specified` at
// `new Intl.DateTimeFormat(..., { timeZone })` in the schedule engine — a 500
// instead of a clean 400 at the schema boundary.
function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export const ianaTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(isValidTimeZone, { message: "must be a valid IANA time zone" });
// Decibels relative to full scale (peak/RMS meter levels, watchdog thresholds).
export const dbfsSchema = z.number().min(-160).max(24);
export const healthSeveritySchema = z.enum(["info", "warning", "critical"]);
export const uploadProviderSchema = z.enum(["stub", "smb", "s3"]);
export const uploadQueueStatusSchema = z.enum([
  "queued",
  "retrying",
  "failed",
  "succeeded",
  "cancelled",
]);

// ISO 8601 calendar date with no time component (e.g. schedule exception dates).
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// 24-hour wall-clock time "HH:MM" used by recurring schedule windows.
export const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}$/);
// Linux audio capture backend selected per node, schedule, or job.
export const audioCaptureBackendSchema = z.enum(["alsa", "jack", "pipewire"]);

export type HealthSeverity = z.infer<typeof healthSeveritySchema>;
export type UploadProvider = z.infer<typeof uploadProviderSchema>;
export type UploadQueueStatus = z.infer<typeof uploadQueueStatusSchema>;
