import type { RecordingSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { listRecordingJobs } from "./recording-jobs.js";

export async function scopedRecordingJobs(
  user: NonNullable<AuthResult["user"]>,
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>,
) {
  const visibleRecordingIds = new Set(
    (await scopedRecordings(user)).map((recording) => recording.id),
  );
  const jobs = await listRecordingJobs();

  return jobs.filter((job) => visibleRecordingIds.has(job.recordingId));
}
