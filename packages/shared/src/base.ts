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
export const uploadProviderSchema = z.enum(["stub", "smb", "s3"]);
export const uploadQueueStatusSchema = z.enum([
  "queued",
  "retrying",
  "failed",
  "succeeded",
  "cancelled",
]);
