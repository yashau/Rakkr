import { z } from "zod";

// Status breakdown of the full filtered recording-job set, computed
// server-side so the workbench summary tiles reflect every matching job rather
// than only the current page (which undercounts once matches exceed the page
// size).
export const recordingJobStatusSummarySchema = z.object({
  active: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  stopRequested: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type RecordingJobStatusSummary = z.infer<typeof recordingJobStatusSummarySchema>;
