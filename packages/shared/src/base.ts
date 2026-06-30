import { z } from "zod";

// Shared primitive schemas with no other dependencies, kept in a leaf module so
// other leaf schema modules (e.g. recording-chunks) can reuse them without an
// import cycle through the main index.

export const isoDateTimeSchema = z.string().min(1);
export const uploadProviderSchema = z.enum(["stub", "smb", "s3"]);
export const uploadQueueStatusSchema = z.enum([
  "queued",
  "retrying",
  "failed",
  "succeeded",
  "cancelled",
]);
