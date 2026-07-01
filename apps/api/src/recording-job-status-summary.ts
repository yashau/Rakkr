import type { RecordingJob, RecordingJobStatusSummary } from "@rakkr/shared";

// Statuses treated as "active" (a job still doing or about to do work).
const activeRecordingJobStatuses: readonly RecordingJob["status"][] = [
  "queued",
  "running",
  "stop_requested",
];

/**
 * Status breakdown for the workbench summary tiles. Computed over the full
 * filtered job set (not the paginated page) so the tiles reflect every matching
 * job — a page-derived count undercounts once matches exceed the page size.
 */
export function recordingJobStatusSummary(
  jobs: readonly RecordingJob[],
): RecordingJobStatusSummary {
  return {
    active: jobs.filter((job) => activeRecordingJobStatuses.includes(job.status)).length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
    stopRequested: jobs.filter((job) => job.status === "stop_requested").length,
    total: jobs.length,
  };
}
