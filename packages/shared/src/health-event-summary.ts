import { z } from "zod";

// Status breakdown of the full filtered health-event set, computed server-side
// so the health summary tiles reflect every matching event rather than only the
// current page (which undercounts once matches exceed the page size). Mirrors
// `recordingJobStatusSummarySchema`.
export const healthEventStatusSummarySchema = z.object({
  activeCritical: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type HealthEventStatusSummary = z.infer<typeof healthEventStatusSummarySchema>;
