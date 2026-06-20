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
import { listRecordingJobs, recordingJob, retryRecordingJob } from "./recording-jobs.js";
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
  search: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().trim().max(160).optional(),
  ),
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    recordingJobStatusSchema.optional(),
  ),
});

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
      return c.json({
        data: await scopedRecordingJobs(currentUser(c)),
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
