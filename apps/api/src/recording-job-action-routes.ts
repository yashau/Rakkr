import type { Context, Hono } from "hono";
import type { Permission, RecordingJob, RecordingSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RequirePermission } from "./http-types.js";
import { scopedRecordingJobs } from "./recording-job-scope.js";
import { listRecordingJobs, recordingJob } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";

interface RecordingJobActionRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
}

interface RecordingJobActionState {
  enabled: boolean;
  href?: string;
  method: "GET" | "POST";
  payload?: Record<string, unknown>;
  permission: Permission;
  reason?: string;
}

const retryableJobStatuses = new Set<RecordingJob["status"]>(["cancelled", "failed"]);
const stoppableJobStatuses = new Set<RecordingJob["status"]>(["queued", "running"]);
const activeJobStatuses = new Set<RecordingJob["status"]>(["queued", "running", "stop_requested"]);

export function registerRecordingJobActionRoutes({
  app,
  currentUser,
  recordingStore,
  requirePermission,
  scopedRecordings,
}: RecordingJobActionRouteDependencies) {
  app.get(
    "/api/v1/recording-jobs/:jobId/actions",
    requirePermission("recording:read", "recording_jobs.actions.read", async (c) => {
      const jobId = c.req.param("jobId") ?? "";
      const job = await recordingJob(jobId);

      return job
        ? { id: job.recordingId, type: "recording" }
        : { id: jobId, type: "recording_job" };
    }),
    async (c) => {
      const jobId = c.req.param("jobId") ?? "";
      const user = currentUser(c);
      const visibleJob = (await scopedRecordingJobs(user, scopedRecordings)).find(
        (job) => job.id === jobId,
      );

      if (!visibleJob) {
        return c.json({ error: "Recording job not found" }, 404);
      }

      const [recording, jobs] = await Promise.all([
        recordingStore.find(visibleJob.recordingId),
        listRecordingJobs(),
      ]);
      const activeConflict = jobs.find(
        (job) =>
          job.id !== visibleJob.id &&
          job.recordingId === visibleJob.recordingId &&
          activeJobStatuses.has(job.status),
      );

      return c.json({
        data: {
          actions: recordingJobActions(
            visibleJob,
            user.permissions,
            Boolean(recording),
            activeConflict,
          ),
          job: visibleJob,
          links: recordingJobActionLinks(visibleJob.id),
          recording,
          retryConflict: activeConflict,
        },
      });
    },
  );
}

function recordingJobActions(
  job: RecordingJob,
  permissions: readonly Permission[],
  recordingExists: boolean,
  activeConflict?: RecordingJob,
) {
  return {
    detail: actionState({
      href: `/api/v1/recording-jobs/${job.id}`,
      method: "GET",
      permission: "recording:read",
      permissions,
      ready: true,
    }),
    exportSelected: actionState({
      href: "/api/v1/recording-jobs/export",
      method: "POST",
      payload: { jobIds: [job.id] },
      permission: "recording:read",
      permissions,
      ready: true,
    }),
    retry: actionState({
      href: `/api/v1/recording-jobs/${job.id}/retry`,
      method: "POST",
      permission: "recording:control",
      permissions,
      ready: retryableJobStatuses.has(job.status) && recordingExists && !activeConflict,
      reason: retryBlockedReason(job, recordingExists, activeConflict),
    }),
    stop: actionState({
      href: "/api/v1/recording-jobs/bulk-stop",
      method: "POST",
      payload: { jobIds: [job.id] },
      permission: "recording:control",
      permissions,
      ready: stoppableJobStatuses.has(job.status) && recordingExists,
      reason: stopBlockedReason(job, recordingExists),
    }),
  };
}

function retryBlockedReason(
  job: RecordingJob,
  recordingExists: boolean,
  activeConflict?: RecordingJob,
) {
  if (!retryableJobStatuses.has(job.status)) {
    return "recording_job_not_retryable";
  }

  if (!recordingExists) {
    return "recording_not_found";
  }

  if (activeConflict) {
    return "active_job_exists";
  }

  return "recording_job_not_retryable";
}

function stopBlockedReason(job: RecordingJob, recordingExists: boolean) {
  if (!stoppableJobStatuses.has(job.status)) {
    return "recording_job_not_stoppable";
  }

  return recordingExists ? "recording_job_not_stoppable" : "recording_not_found";
}

function actionState({
  href,
  method,
  payload,
  permission,
  permissions,
  ready,
  reason,
}: {
  href?: string;
  method: RecordingJobActionState["method"];
  payload?: Record<string, unknown>;
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): RecordingJobActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, payload, permission }
    : { enabled: false, method, payload, permission, reason };
}

function recordingJobActionLinks(jobId: string) {
  return {
    bulkRetry: "/api/v1/recording-jobs/bulk-retry",
    bulkStop: "/api/v1/recording-jobs/bulk-stop",
    detail: `/api/v1/recording-jobs/${jobId}`,
    exportSelected: "/api/v1/recording-jobs/export",
    retry: `/api/v1/recording-jobs/${jobId}/retry`,
  };
}
