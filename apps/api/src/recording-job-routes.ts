import type { Context, Hono } from "hono";
import { z } from "zod";
import { recordingJobStatusSchema, type RecordingSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import {
  filterRecordingJobsForExport,
  recordingJobsCsv,
  recordingJobsExportFileName,
} from "./recording-job-export.js";
import {
  listRecordingJobs,
  recordingJob,
  retryRecordingJob,
  stopRecordingJobById,
} from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";

interface RecordingJobRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
}

const recordingJobsQuerySchema = z.object({
  captureBackend: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.enum(["alsa", "jack", "pipewire"]).optional(),
  ),
  captureInterfaceId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().trim().max(160).optional(),
  ),
  search: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().trim().max(160).optional(),
  ),
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    recordingJobStatusSchema.optional(),
  ),
});
const recordingJobBulkActionSchema = z
  .object({
    jobIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();
const recordingJobSelectedExportSchema = z
  .object({
    jobIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();
const retryableJobStatuses = new Set(["cancelled", "failed"]);
const stoppableJobStatuses = new Set(["queued", "running"]);

export function registerRecordingJobRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scopedRecordings,
}: RecordingJobRouteDependencies) {
  app.get(
    "/api/v1/recording-jobs",
    requirePermission("recording:read", "recording_jobs.read"),
    async (c) => {
      const query = recordingJobsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid recording job filters", issues: query.error.issues }, 400);
      }

      return c.json({
        data: filterRecordingJobsForExport(await scopedRecordingJobs(currentUser(c)), query.data),
      });
    },
  );

  app.get(
    "/api/v1/recording-jobs/export",
    requirePermission("recording:read", "recording_jobs.export", () => ({
      id: "recording_job_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const query = recordingJobsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid recording job filters", issues: query.error.issues }, 400);
      }

      const jobs = filterRecordingJobsForExport(
        await scopedRecordingJobs(currentUser(c)),
        query.data,
      );

      await recordAuditEvent(c, {
        action: "recording_jobs.export.succeeded",
        auth: currentAuth(c),
        details: {
          exportedCount: jobs.length,
          filters: query.data,
        },
        outcome: "succeeded",
        permission: "recording:read",
        target: {
          id: "recording_job_collection",
          type: "recording_collection",
        },
      });

      return c.body(recordingJobsCsv(jobs), 200, {
        "Content-Disposition": `attachment; filename="${recordingJobsExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.post(
    "/api/v1/recording-jobs/export",
    requirePermission("recording:read", "recording_jobs.export_selected", () => ({
      id: "recording_job_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const body = recordingJobSelectedExportSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSelectedJobExportFailure(c, "invalid_request");
        return c.json(
          { error: "Invalid recording job export request", issues: body.error.issues },
          400,
        );
      }

      const jobIds = uniqueJobIds(body.data.jobIds);
      const visibleJobMap = new Map(
        (await scopedRecordingJobs(currentUser(c))).map((job) => [job.id, job]),
      );
      const hiddenIds = jobIds.filter((jobId) => !visibleJobMap.has(jobId));

      if (hiddenIds.length > 0) {
        await recordSelectedJobExportFailure(c, "recording_job_not_visible", {
          hiddenIds,
          jobIds,
        });
        return c.json({ error: "One or more recording jobs are not visible" }, 404);
      }

      const jobs = jobIds.map((jobId) => visibleJobMap.get(jobId)!);

      await recordAuditEvent(c, {
        action: "recording_jobs.export_selected.succeeded",
        auth: currentAuth(c),
        correlationIds: Object.fromEntries(
          jobIds.map((jobId, index) => [`jobId${index + 1}`, jobId]),
        ),
        details: {
          exportedCount: jobs.length,
          requestedCount: body.data.jobIds.length,
        },
        outcome: "succeeded",
        permission: "recording:read",
        target: {
          id: "recording_job_collection",
          type: "recording_collection",
        },
      });

      return c.body(recordingJobsCsv(jobs), 200, {
        "Content-Disposition": `attachment; filename="${recordingJobsExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.post(
    "/api/v1/recording-jobs/bulk-retry",
    requirePermission("recording:control", "recording_jobs.bulk_retry", () => ({
      id: "recording_job_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const body = recordingJobBulkActionSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordBulkJobFailure(c, "recording_jobs.bulk_retry.failed", "invalid_request");
        return c.json(
          { error: "Invalid recording job retry request", issues: body.error.issues },
          400,
        );
      }

      const jobIds = uniqueJobIds(body.data.jobIds);
      const visibleJobs = await scopedRecordingJobs(currentUser(c));
      const visibleJobMap = new Map(visibleJobs.map((job) => [job.id, job]));
      const hiddenIds = jobIds.filter((jobId) => !visibleJobMap.has(jobId));

      if (hiddenIds.length > 0) {
        await recordBulkJobFailure(
          c,
          "recording_jobs.bulk_retry.failed",
          "recording_job_not_visible",
          {
            hiddenIds,
            jobIds,
          },
        );
        return c.json({ error: "One or more recording jobs are not visible" }, 404);
      }

      const sourceJobs = jobIds.map((jobId) => visibleJobMap.get(jobId)!);
      const ineligibleIds = sourceJobs
        .filter((job) => !retryableJobStatuses.has(job.status))
        .map((job) => job.id);

      if (ineligibleIds.length > 0) {
        await recordBulkJobFailure(
          c,
          "recording_jobs.bulk_retry.failed",
          "recording_job_not_retryable",
          {
            ineligibleIds,
            jobIds,
          },
        );
        return c.json({ error: "One or more recording jobs cannot be retried" }, 409);
      }

      const duplicateRecordingIds = duplicateValues(sourceJobs.map((job) => job.recordingId));

      if (duplicateRecordingIds.length > 0) {
        await recordBulkJobFailure(
          c,
          "recording_jobs.bulk_retry.failed",
          "duplicate_recording_selection",
          {
            duplicateRecordingIds,
            jobIds,
          },
        );
        return c.json({ error: "Only one retry job per recording can be created at once" }, 409);
      }

      const recordings = new Map<string, RecordingSummary>();

      for (const job of sourceJobs) {
        const recording = await recordingStore.find(job.recordingId);

        if (!recording) {
          await recordBulkJobFailure(c, "recording_jobs.bulk_retry.failed", "recording_not_found", {
            jobIds,
            recordingId: job.recordingId,
          });
          return c.json({ error: "One or more recordings were not found" }, 404);
        }

        recordings.set(recording.id, recording);
      }

      const selectedJobIds = new Set(jobIds);
      const activeConflicts = (await listRecordingJobs()).filter(
        (job) =>
          !selectedJobIds.has(job.id) &&
          sourceJobs.some((sourceJob) => sourceJob.recordingId === job.recordingId) &&
          (job.status === "queued" || job.status === "running" || job.status === "stop_requested"),
      );

      if (activeConflicts.length > 0) {
        await recordBulkJobFailure(c, "recording_jobs.bulk_retry.failed", "active_job_exists", {
          activeJobIds: activeConflicts.map((job) => job.id),
          jobIds,
        });
        return c.json({ error: "One or more recordings already have active jobs" }, 409);
      }

      const retriedJobs = [];
      const before = [];
      const after = [];

      for (const sourceJob of sourceJobs) {
        const result = await retryRecordingJob(sourceJob.id);

        if (!result.ok) {
          await recordBulkJobFailure(c, "recording_jobs.bulk_retry.failed", result.reason, {
            jobIds,
            sourceJobId: sourceJob.id,
          });
          return c.json(
            { error: "Recording jobs could not all be retried", reason: result.reason },
            409,
          );
        }

        const recording = recordings.get(sourceJob.recordingId)!;
        const updated = recordingForRetriedJob(recording, result.job.createdAt);

        await recordingStore.save(updated);
        retriedJobs.push(result.job);
        before.push({ jobId: sourceJob.id, recordingId: recording.id, status: sourceJob.status });
        after.push({ jobId: result.job.id, recordingId: updated.id, status: result.job.status });
      }

      await recordAuditEvent(c, {
        action: "recording_jobs.bulk_retry.succeeded",
        after: { jobs: after },
        auth: currentAuth(c),
        before: { jobs: before },
        correlationIds: Object.fromEntries(
          retriedJobs.map((job, index) => [`retryJobId${index + 1}`, job.id]),
        ),
        details: {
          requestedCount: body.data.jobIds.length,
          retriedCount: retriedJobs.length,
          sourceJobIds: jobIds,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: "recording_job_collection",
          type: "recording_collection",
        },
      });

      return c.json({ data: retriedJobs, meta: { retriedCount: retriedJobs.length } }, 201);
    },
  );

  app.post(
    "/api/v1/recording-jobs/bulk-stop",
    requirePermission("recording:control", "recording_jobs.bulk_stop", () => ({
      id: "recording_job_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const body = recordingJobBulkActionSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordBulkJobFailure(c, "recording_jobs.bulk_stop.failed", "invalid_request");
        return c.json(
          { error: "Invalid recording job stop request", issues: body.error.issues },
          400,
        );
      }

      const jobIds = uniqueJobIds(body.data.jobIds);
      const visibleJobs = await scopedRecordingJobs(currentUser(c));
      const visibleJobMap = new Map(visibleJobs.map((job) => [job.id, job]));
      const hiddenIds = jobIds.filter((jobId) => !visibleJobMap.has(jobId));

      if (hiddenIds.length > 0) {
        await recordBulkJobFailure(
          c,
          "recording_jobs.bulk_stop.failed",
          "recording_job_not_visible",
          {
            hiddenIds,
            jobIds,
          },
        );
        return c.json({ error: "One or more recording jobs are not visible" }, 404);
      }

      const sourceJobs = jobIds.map((jobId) => visibleJobMap.get(jobId)!);
      const ineligibleIds = sourceJobs
        .filter((job) => !stoppableJobStatuses.has(job.status))
        .map((job) => job.id);

      if (ineligibleIds.length > 0) {
        await recordBulkJobFailure(
          c,
          "recording_jobs.bulk_stop.failed",
          "recording_job_not_stoppable",
          {
            ineligibleIds,
            jobIds,
          },
        );
        return c.json({ error: "One or more recording jobs cannot be stopped" }, 409);
      }

      const recordings = new Map<string, RecordingSummary>();

      for (const job of sourceJobs) {
        const recording = await recordingStore.find(job.recordingId);

        if (!recording) {
          await recordBulkJobFailure(c, "recording_jobs.bulk_stop.failed", "recording_not_found", {
            jobIds,
            recordingId: job.recordingId,
          });
          return c.json({ error: "One or more recordings were not found" }, 404);
        }

        recordings.set(recording.id, recording);
      }

      const stoppedJobs = [];
      const before = [];
      const after = [];

      for (const sourceJob of sourceJobs) {
        const stopped = await stopRecordingJobById(sourceJob.id);

        if (!stopped) {
          await recordBulkJobFailure(
            c,
            "recording_jobs.bulk_stop.failed",
            "recording_job_not_stoppable",
            {
              jobIds,
              sourceJobId: sourceJob.id,
            },
          );
          return c.json({ error: "Recording jobs could not all be stopped" }, 409);
        }

        const recording = recordings.get(sourceJob.recordingId)!;
        const beforeRecordingStatus = recording.status;

        recording.durationSeconds = Math.max(recording.durationSeconds, 1);
        recording.status = "completed";
        await recordingStore.save(recording);

        stoppedJobs.push(stopped);
        before.push({
          jobId: sourceJob.id,
          recordingId: recording.id,
          recordingStatus: beforeRecordingStatus,
          status: sourceJob.status,
        });
        after.push({
          jobId: stopped.id,
          recordingId: recording.id,
          recordingStatus: recording.status,
          status: stopped.status,
        });
      }

      await recordAuditEvent(c, {
        action: "recording_jobs.bulk_stop.succeeded",
        after: { jobs: after },
        auth: currentAuth(c),
        before: { jobs: before },
        correlationIds: Object.fromEntries(
          stoppedJobs.map((job, index) => [`jobId${index + 1}`, job.id]),
        ),
        details: {
          requestedCount: body.data.jobIds.length,
          stoppedCount: stoppedJobs.length,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: "recording_job_collection",
          type: "recording_collection",
        },
      });

      return c.json({ data: stoppedJobs, meta: { stoppedCount: stoppedJobs.length } });
    },
  );

  app.post(
    "/api/v1/recording-jobs/:jobId/retry",
    requirePermission("recording:control", "recording_jobs.retry", async (c) => {
      const jobId = c.req.param("jobId") ?? "";
      const job = await recordingJob(jobId);

      return job
        ? { id: job.recordingId, type: "recording" }
        : { id: jobId, type: "recording_job" };
    }),
    async (c) => {
      const jobId = c.req.param("jobId") ?? "";
      const visibleJobs = await scopedRecordingJobs(currentUser(c));
      const visibleJob = visibleJobs.find((job) => job.id === jobId);

      if (!visibleJob) {
        await recordAuditEvent(c, {
          action: "recording_jobs.retry.failed",
          auth: currentAuth(c),
          outcome: "denied",
          permission: "recording:control",
          reason: "recording_job_not_visible",
          target: {
            id: jobId,
            type: "recording_job",
          },
        });

        return c.json({ error: "Recording job not found" }, 404);
      }

      const recording = await recordingStore.find(visibleJob.recordingId);

      if (!recording) {
        await recordAuditEvent(c, {
          action: "recording_jobs.retry.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "recording:control",
          reason: "recording_not_found",
          target: {
            id: visibleJob.recordingId,
            type: "recording",
          },
        });

        return c.json({ error: "Recording not found" }, 404);
      }

      const result = await retryRecordingJob(jobId);

      if (!result.ok) {
        const activeJobId =
          result.reason === "active_job_exists" && result.activeJob
            ? result.activeJob.id
            : undefined;

        await recordAuditEvent(c, {
          action: "recording_jobs.retry.failed",
          auth: currentAuth(c),
          details: {
            activeJobId,
            sourceJobStatus: result.job?.status,
          },
          outcome: "failed",
          permission: "recording:control",
          reason: result.reason,
          target: {
            id: recording.id,
            name: recording.name,
            type: "recording",
          },
        });

        return c.json(
          { error: "Recording job cannot be retried", reason: result.reason },
          result.reason === "job_not_found" ? 404 : 409,
        );
      }

      const updated = recordingForRetriedJob(recording, result.job.createdAt);

      await recordingStore.save(updated);
      await recordAuditEvent(c, {
        action: "recording_jobs.retry.succeeded",
        after: {
          jobId: result.job.id,
          recordingStatus: updated.status,
          status: result.job.status,
        },
        auth: currentAuth(c),
        before: {
          jobId: result.sourceJob.id,
          recordingStatus: recording.status,
          status: result.sourceJob.status,
        },
        correlationIds: {
          recordingId: recording.id,
          retryJobId: result.job.id,
          sourceJobId: result.sourceJob.id,
        },
        details: {
          captureDevice: result.job.command.captureDevice,
          nodeId: result.job.nodeId,
          outputFileName: result.job.command.outputFileName,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.json({ data: result.job }, 201);
    },
  );

  async function scopedRecordingJobs(user: NonNullable<AuthResult["user"]>) {
    const visibleRecordingIds = new Set(
      (await scopedRecordings(user)).map((recording) => recording.id),
    );
    const jobs = await listRecordingJobs();

    return jobs.filter((job) => visibleRecordingIds.has(job.recordingId));
  }

  async function recordBulkJobFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      details,
      outcome: reason === "recording_job_not_visible" ? "denied" : "failed",
      permission: "recording:control",
      reason,
      target: {
        id: "recording_job_collection",
        type: "recording_collection",
      },
    });
  }

  async function recordSelectedJobExportFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "recording_jobs.export_selected.failed",
      auth: currentAuth(c),
      details,
      outcome: reason === "recording_job_not_visible" ? "denied" : "failed",
      permission: "recording:read",
      reason,
      target: {
        id: "recording_job_collection",
        type: "recording_collection",
      },
    });
  }
}

function recordingForRetriedJob(recording: RecordingSummary, retriedAt: string) {
  return {
    ...recording,
    cached: false,
    cachePath: undefined,
    checksum: undefined,
    durationSeconds: 0,
    healthStatus: "unknown" as const,
    recordedAt: retriedAt,
    status: "recording" as const,
    waveformPreview: undefined,
  };
}

function uniqueJobIds(jobIds: string[]) {
  return Array.from(new Set(jobIds));
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return Array.from(duplicates);
}
