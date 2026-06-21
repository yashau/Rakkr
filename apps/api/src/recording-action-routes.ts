import type { Context, Hono } from "hono";
import type { Permission, RecordingJob, RecordingSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RequirePermission } from "./http-types.js";
import { recordingHasCachedFile } from "./recording-cache.js";
import { listRecordingJobs } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import { listUploadQueueItems } from "./upload-queue.js";

interface RecordingActionRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
}

interface RecordingActionState {
  enabled: boolean;
  href?: string;
  method: "DELETE" | "PATCH" | "POST";
  permission: Permission;
  reason?: string;
}

const activeRecordingStatuses = new Set<RecordingSummary["status"]>(["queued", "recording"]);
const activeJobStatuses = new Set<RecordingJob["status"]>(["queued", "running", "stop_requested"]);
const retryableJobStatuses = new Set<RecordingJob["status"]>(["cancelled", "failed"]);

export function registerRecordingActionRoutes({
  app,
  currentUser,
  recordingStore,
  requirePermission,
  scopedRecordings,
}: RecordingActionRouteDependencies) {
  app.get(
    "/api/v1/recordings/:recordingId/actions",
    requirePermission("recording:read", "recordings.actions.read", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const user = currentUser(c);
      const visibleRecording = (await scopedRecordings(user)).find(
        (candidate) => candidate.id === recordingId,
      );

      if (!visibleRecording) {
        return c.json({ error: "Recording not found" }, 404);
      }

      const [recording, jobs, uploadQueueItems] = await Promise.all([
        recordingStore.find(recordingId),
        listRecordingJobs(),
        listUploadQueueItems(),
      ]);

      if (!recording) {
        return c.json({ error: "Recording not found" }, 404);
      }

      const recordingJobs = jobs
        .filter((job) => job.recordingId === recording.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const activeJob = recordingJobs.find((job) => activeJobStatuses.has(job.status));
      const retryableJob = activeJob
        ? undefined
        : recordingJobs.find((job) => retryableJobStatuses.has(job.status));
      const queuedUploads = uploadQueueItems.filter((item) => item.recordingId === recording.id);

      return c.json({
        data: {
          actions: recordingActions(recording, user.permissions, activeJob, retryableJob),
          jobs: {
            active: activeJob,
            latest: recordingJobs[0],
            retryable: retryableJob,
          },
          links: recordingActionLinks(recording.id, retryableJob?.id),
          recording,
          uploadQueueItems: queuedUploads,
        },
      });
    },
  );
}

function recordingActions(
  recording: RecordingSummary,
  permissions: readonly Permission[],
  activeJob?: RecordingJob,
  retryableJob?: RecordingJob,
) {
  const cached = recordingHasCachedFile(recording);
  const active = activeRecordingStatuses.has(recording.status) || Boolean(activeJob);
  const terminal = !activeRecordingStatuses.has(recording.status);
  const basePath = `/api/v1/recordings/${recording.id}`;

  return {
    delete: actionState({
      href: basePath,
      method: "DELETE",
      permission: "recording:delete",
      permissions,
      ready: terminal,
      reason: "recording_active",
    }),
    download: actionState({
      href: `${basePath}/download`,
      method: "POST",
      permission: "recording:download",
      permissions,
      ready: cached,
      reason: "recording_not_cached",
    }),
    editMetadata: actionState({
      href: `${basePath}/metadata`,
      method: "PATCH",
      permission: "recording:edit",
      permissions,
      ready: true,
    }),
    playback: actionState({
      href: `${basePath}/playback`,
      method: "POST",
      permission: "recording:playback",
      permissions,
      ready: cached,
      reason: "recording_not_cached",
    }),
    queueUpload: actionState({
      href: `${basePath}/upload-queue`,
      method: "POST",
      permission: "recording:control",
      permissions,
      ready: cached,
      reason: "recording_not_cached",
    }),
    retryJob: actionState({
      href: retryableJob ? `/api/v1/recording-jobs/${retryableJob.id}/retry` : undefined,
      method: "POST",
      permission: "recording:control",
      permissions,
      ready: Boolean(retryableJob),
      reason: activeJob ? "active_job_exists" : "recording_job_not_retryable",
    }),
    stop: actionState({
      href: `${basePath}/stop`,
      method: "POST",
      permission: "recording:control",
      permissions,
      ready: active,
      reason: "recording_not_active",
    }),
  };
}

function actionState({
  href,
  method,
  permission,
  permissions,
  ready,
  reason,
}: {
  href?: string;
  method: RecordingActionState["method"];
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): RecordingActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason };
}

function recordingActionLinks(recordingId: string, retryJobId?: string) {
  const basePath = `/api/v1/recordings/${recordingId}`;

  return {
    delete: basePath,
    download: `${basePath}/download`,
    file: `${basePath}/file`,
    metadata: `${basePath}/metadata`,
    playback: `${basePath}/playback`,
    retryJob: retryJobId ? `/api/v1/recording-jobs/${retryJobId}/retry` : undefined,
    stop: `${basePath}/stop`,
    stream: `${basePath}/stream`,
    uploadQueue: `${basePath}/upload-queue`,
  };
}
