import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  defaultKeepControllerCacheRetentionPolicy,
  defaultVoiceRecordingProfile,
  type RecorderNode,
  type RecordingSummary,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import { registerRecordingActionRoutes } from "./recording-action-routes.js";
import { registerRecordingJobRoutes } from "./recording-job-routes.js";
import { recordingJobTargetOptions } from "./recording-job-targets.js";
import { createRecordingJob, listRecordingJobs, stopRecordingJob } from "./recording-jobs.js";
import {
  filterRecordings,
  recordingManifestCsv,
  recordingsQuerySchema,
} from "./recording-listing.js";
import {
  defaultAdHocFolder,
  defaultAdHocName,
  recordingExportFileName,
  recordingStartTarget,
  requestedInterfaceBelongsToNode,
} from "./recording-start-targets.js";
import { loadRecordingFile, recordingFileName, recordingHasCachedFile } from "./recording-cache.js";
import { deleteRecording, deleteRecordings } from "./recording-delete.js";
import { registerRecordingReadRoutes } from "./recording-read-routes.js";
import { createRecordingRouteAudit } from "./recording-route-audit.js";
import {
  applyRecordingBulkMetadataUpdate,
  applyRecordingMetadataUpdate,
  bulkMetadataFields,
  recordingBulkMetadataUpdateSchema,
  recordingMetadataSnapshot,
  recordingMetadataUpdateSchema,
  uniqueRecordingIds,
  uniqueTags,
} from "./recording-metadata.js";
import { registerRecordingUploadQueueRoutes } from "./recording-upload-queue-routes.js";
import type { UploadDestinationStore } from "./upload-destinations.js";
import type { RecordingStore } from "./recording-store.js";
import { findRetentionPolicy } from "./retention-policies.js";
import type { SettingsStore } from "./settings-store.js";
import {
  profileSettingsTarget,
  retentionPolicySettingsTarget,
  uploadPolicySettingsTarget,
} from "./settings-scope.js";
import { findUploadPolicy, uploadPolicyForQueue } from "./upload-policies.js";

interface RecordingRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope?(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  healthEventStore?: HealthEventStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
  settingsStore: SettingsStore;
  uploadDestinationStore: UploadDestinationStore;
}

const recordingStartRequestSchema = z
  .object({
    captureBackend: z.enum(["alsa", "jack", "pipewire"]).optional(),
    captureInterfaceId: z.string().trim().min(1).max(160).optional(),
    folder: z.string().trim().min(1).max(240).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    nodeId: z.string().trim().min(1).max(160),
    recordingProfileId: z.string().trim().min(1).max(160).optional(),
    retentionPolicyId: z.string().trim().min(1).max(160).optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(32).optional(),
    uploadPolicyIds: z.array(z.string().trim().min(1).max(160)).max(16).optional(),
  })
  .strict();
const recordingSelectedExportSchema = z
  .object({
    recordingIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();
const capacityReservedRecordingJobStatuses = new Set(["queued", "running", "stop_requested"]);

export function registerRecordingRoutes({
  app,
  currentAuth,
  currentUser,
  hasResourceScope = async () => true,
  healthEventStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scopedNodes,
  scopedRecordings,
  settingsStore,
  uploadDestinationStore,
}: RecordingRouteDependencies) {
  const recordingAudit = createRecordingRouteAudit({ currentAuth, recordAuditEvent });

  async function serveRecordingFile(
    c: Context<AppBindings>,
    recordingId: string,
    disposition: "attachment" | "inline",
    permission: "recording:download" | "recording:playback",
  ) {
    const recording = await findScopedRecording(c, recordingId);
    const renditionParam = c.req.query("rendition");
    const rendition =
      renditionParam === "raw" || renditionParam === "enhanced" ? renditionParam : undefined;
    const action =
      disposition === "attachment" ? "recordings.download.file" : "recordings.playback.stream";

    if (!recording || !recordingHasCachedFile(recording)) {
      await recordingAudit.fileFailure(c, {
        action: `${action}.failed`,
        permission,
        reason: recording ? "recording_not_cached" : "recording_not_found",
        recordingId,
        targetName: recording?.name,
      });

      return c.json(
        { error: recording ? "Recording is not cached" : "Recording not found" },
        recording ? 409 : 404,
      );
    }

    try {
      const file = await loadRecordingFile(recording, rendition);

      await recordAuditEvent(c, {
        action: `${action}.succeeded`,
        auth: currentAuth(c),
        details: {
          disposition,
          fileName: file.fileName,
          rendition: rendition ?? "default",
          size: file.size,
        },
        outcome: "succeeded",
        permission,
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.body(new Uint8Array(file.bytes), 200, {
        "Content-Disposition": `${disposition}; filename="${file.fileName}"`,
        "Content-Length": file.size.toString(),
        "Content-Type": file.mimeType,
      });
    } catch (error) {
      await recordingAudit.fileFailure(c, {
        action: `${action}.failed`,
        permission,
        reason: error instanceof Error ? error.message : "recording_cache_read_failed",
        recordingId,
        targetName: recording.name,
      });

      return c.json({ error: "Recording cache file is unavailable" }, 409);
    }
  }

  app.get(
    "/api/v1/recordings/export",
    requirePermission("recording:read", "recordings.export", () => ({
      id: "recording_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const query = recordingsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid recording filters", issues: query.error.issues }, 400);
      }

      const recordings = filterRecordings(await scopedRecordings(currentUser(c)), query.data);
      const fileName = recordingExportFileName(new Date());

      await recordAuditEvent(c, {
        action: "recordings.export.succeeded",
        auth: currentAuth(c),
        details: {
          exportedCount: recordings.length,
          filters: query.data,
        },
        outcome: "succeeded",
        permission: "recording:read",
        target: {
          id: "recording_collection",
          type: "recording_collection",
        },
      });

      return c.body(recordingManifestCsv(recordings), 200, {
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.post(
    "/api/v1/recordings/export",
    requirePermission("recording:read", "recordings.export_selected", () => ({
      id: "recording_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const body = recordingSelectedExportSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSelectedExportFailure(c, "invalid_request");
        return c.json(
          { error: "Invalid recording export request", issues: body.error.issues },
          400,
        );
      }

      const recordingIds = uniqueRecordingIds(body.data.recordingIds);
      const visibleRecordings = new Map(
        (await scopedRecordings(currentUser(c))).map((recording) => [recording.id, recording]),
      );
      const hiddenIds = recordingIds.filter((recordingId) => !visibleRecordings.has(recordingId));

      if (hiddenIds.length > 0) {
        await recordSelectedExportFailure(c, "recording_not_visible", {
          hiddenIds,
          recordingIds,
        });
        return c.json({ error: "One or more recordings are not visible" }, 404);
      }

      const recordings = recordingIds.map((recordingId) => visibleRecordings.get(recordingId)!);
      const fileName = recordingExportFileName(new Date());

      await recordAuditEvent(c, {
        action: "recordings.export_selected.succeeded",
        auth: currentAuth(c),
        correlationIds: Object.fromEntries(
          recordingIds.map((recordingId, index) => [`recordingId${index + 1}`, recordingId]),
        ),
        details: {
          exportedCount: recordings.length,
          requestedCount: body.data.recordingIds.length,
        },
        outcome: "succeeded",
        permission: "recording:read",
        target: {
          id: "recording_collection",
          type: "recording_collection",
        },
      });

      return c.body(recordingManifestCsv(recordings), 200, {
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  registerRecordingReadRoutes({
    app,
    currentAuth,
    currentUser,
    healthEventStore,
    recordAuditEvent,
    requirePermission,
    scopedRecordings,
  });

  registerRecordingActionRoutes({
    app,
    currentUser,
    recordAuditEvent,
    requirePermission,
    scopedRecordings,
  });

  registerRecordingJobRoutes({
    app,
    currentAuth,
    currentUser,
    recordAuditEvent,
    recordingStore,
    requirePermission,
    scopedRecordings,
  });

  registerRecordingUploadQueueRoutes({
    app,
    currentAuth,
    currentUser,
    recordAuditEvent,
    requirePermission,
    scopedRecordings,
    uploadDestinationStore,
  });

  app.post(
    "/api/v1/recordings/:recordingId/playback",
    requirePermission("recording:playback", "recordings.playback.start", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = await findScopedRecording(c, recordingId);

      if (!recording || !recordingHasCachedFile(recording)) {
        await recordingAudit.fileFailure(c, {
          action: "recordings.playback.failed",
          permission: "recording:playback",
          reason: recording ? "recording_not_cached" : "recording_not_found",
          recordingId,
          targetName: recording?.name,
        });

        return c.json(
          { error: recording ? "Recording is not ready for playback" : "Recording not found" },
          recording ? 409 : 404,
        );
      }

      const sessionId = `playback_${randomUUID()}`;

      await recordAuditEvent(c, {
        action: "recordings.playback.started",
        auth: currentAuth(c),
        correlationIds: {
          playbackSessionId: sessionId,
          recordingId: recording.id,
        },
        details: {
          mode: "controller_cache",
          source: recording.source,
        },
        outcome: "succeeded",
        permission: "recording:playback",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.json(
        {
          data: {
            mode: "controller_cache",
            recordingId: recording.id,
            sessionId,
            startedAt: new Date().toISOString(),
            streamUrl: `/api/v1/recordings/${recording.id}/stream`,
          },
        },
        202,
      );
    },
  );

  app.post(
    "/api/v1/recordings/:recordingId/download",
    requirePermission("recording:download", "recordings.download.prepare", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = await findScopedRecording(c, recordingId);

      if (!recording || !recordingHasCachedFile(recording)) {
        await recordingAudit.fileFailure(c, {
          action: "recordings.download.failed",
          permission: "recording:download",
          reason: recording ? "recording_not_cached" : "recording_not_found",
          recordingId,
          targetName: recording?.name,
        });

        return c.json(
          { error: recording ? "Recording is not ready for download" : "Recording not found" },
          recording ? 409 : 404,
        );
      }

      const downloadId = `download_${randomUUID()}`;

      await recordAuditEvent(c, {
        action: "recordings.download.prepared",
        auth: currentAuth(c),
        correlationIds: {
          downloadId,
          recordingId: recording.id,
        },
        details: {
          fileName: recordingFileName(recording),
          mode: "controller_cache",
        },
        outcome: "succeeded",
        permission: "recording:download",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.json(
        {
          data: {
            downloadId,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            fileName: recordingFileName(recording),
            mode: "controller_cache",
            recordingId: recording.id,
            url: `/api/v1/recordings/${recording.id}/file`,
          },
        },
        202,
      );
    },
  );

  app.get(
    "/api/v1/recordings/:recordingId/stream",
    requirePermission("recording:playback", "recordings.playback.stream", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => serveRecordingFile(c, c.req.param("recordingId"), "inline", "recording:playback"),
  );

  app.get(
    "/api/v1/recordings/:recordingId/file",
    requirePermission("recording:download", "recordings.download.file", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) =>
      serveRecordingFile(c, c.req.param("recordingId"), "attachment", "recording:download"),
  );

  app.patch(
    "/api/v1/recordings/bulk-metadata",
    requirePermission("recording:edit", "recordings.metadata.bulk_update", () => ({
      id: "recording_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const body = recordingBulkMetadataUpdateSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );

      if (!body.success) {
        await recordBulkMetadataFailure(c, "invalid_request");
        return c.json({ error: "Invalid recording bulk metadata", issues: body.error.issues }, 400);
      }

      const recordingIds = uniqueRecordingIds(body.data.recordingIds);
      const visibleRecordingMap = new Map(
        (await scopedRecordings(currentUser(c))).map((recording) => [recording.id, recording]),
      );
      const hiddenIds = recordingIds.filter((recordingId) => !visibleRecordingMap.has(recordingId));

      if (hiddenIds.length > 0) {
        await recordBulkMetadataFailure(c, "recording_not_visible", { hiddenIds, recordingIds });
        return c.json({ error: "One or more recordings are not visible" }, 404);
      }

      const updates: RecordingSummary[] = [];
      const before = [];
      const after = [];

      for (const recordingId of recordingIds) {
        const recording = visibleRecordingMap.get(recordingId)!;

        const updated = applyRecordingBulkMetadataUpdate(recording, body.data);

        before.push({ id: recording.id, ...recordingMetadataSnapshot(recording) });
        after.push({ id: updated.id, ...recordingMetadataSnapshot(updated) });
        await recordingStore.save(updated);
        updates.push(updated);
      }

      await recordAuditEvent(c, {
        action: "recordings.metadata.bulk_update.succeeded",
        after: { recordings: after },
        auth: currentAuth(c),
        before: { recordings: before },
        correlationIds: Object.fromEntries(
          recordingIds.map((recordingId, index) => [`recordingId${index + 1}`, recordingId]),
        ),
        details: {
          fields: bulkMetadataFields(body.data),
          requestedCount: body.data.recordingIds.length,
          updatedCount: updates.length,
        },
        outcome: "succeeded",
        permission: "recording:edit",
        target: {
          id: "recording_collection",
          type: "recording_collection",
        },
      });

      return c.json({ data: updates, meta: { updatedCount: updates.length } });
    },
  );

  app.post(
    "/api/v1/recordings/bulk-delete",
    requirePermission("recording:delete", "recordings.bulk_delete", () => ({
      id: "recording_collection",
      type: "recording_collection",
    })),
    async (c) =>
      deleteRecordings(c, {
        currentAuth,
        currentUser,
        recordAuditEvent,
        recordingStore,
        scopedRecordings,
      }),
  );

  app.patch(
    "/api/v1/recordings/:recordingId/metadata",
    requirePermission("recording:edit", "recordings.metadata.update", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const body = recordingMetadataUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordAuditEvent(c, {
          action: "recordings.metadata.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "recording:edit",
          reason: "invalid_request",
          target: {
            id: recordingId,
            type: "recording",
          },
        });

        return c.json({ error: "Invalid recording metadata", issues: body.error.issues }, 400);
      }

      const recording = await findScopedRecording(c, recordingId);

      if (!recording) {
        await recordAuditEvent(c, {
          action: "recordings.metadata.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "recording:edit",
          reason: "recording_not_found",
          target: {
            id: recordingId,
            type: "recording",
          },
        });

        return c.json({ error: "Recording not found" }, 404);
      }

      const before = recordingMetadataSnapshot(recording);
      const updated = applyRecordingMetadataUpdate(recording, body.data);

      await recordingStore.save(updated);

      await recordAuditEvent(c, {
        action: "recordings.metadata.update.succeeded",
        after: recordingMetadataSnapshot(updated),
        auth: currentAuth(c),
        before,
        details: {
          fields: Object.keys(body.data),
        },
        outcome: "succeeded",
        permission: "recording:edit",
        target: {
          id: updated.id,
          name: updated.name,
          type: "recording",
        },
      });

      return c.json({ data: updated });
    },
  );

  app.delete(
    "/api/v1/recordings/:recordingId",
    requirePermission("recording:delete", "recordings.delete", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) =>
      deleteRecording(c, {
        currentAuth,
        currentUser,
        recordAuditEvent,
        recordingStore,
        scopedRecordings,
      }),
  );

  app.post(
    "/api/v1/recordings",
    requirePermission("recording:create", "recordings.start", recordingStartTarget),
    async (c) => {
      const body = recordingStartRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordRecordingStartFailure(c, "invalid_request");
        return c.json({ error: "Invalid recording start request", issues: body.error.issues }, 400);
      }

      const now = new Date();
      const node = (await scopedNodes(currentUser(c))).find(
        (candidate) => candidate.id === body.data.nodeId,
      );

      if (!node) {
        await recordRecordingStartFailure(c, "node_not_found", body.data.nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

      if (!requestedInterfaceBelongsToNode(node, body.data.captureInterfaceId)) {
        await recordRecordingStartFailure(c, "recording_interface_not_found", node.id, node.alias);
        return c.json({ error: "Recording interface not found" }, 409);
      }

      const recordingProfileId = body.data.recordingProfileId ?? defaultVoiceRecordingProfile.id;
      const profile = await settingsStore.findRecordingProfile(recordingProfileId);

      if (!profile) {
        await recordRecordingStartFailure(c, "recording_profile_not_found", node.id, node.alias);
        return c.json({ error: "Recording profile not found" }, 404);
      }

      if (
        body.data.recordingProfileId &&
        !(await hasResourceScope(currentUser(c), profileSettingsTarget(profile)))
      ) {
        await recordRecordingStartFailure(
          c,
          "missing_resource_scope",
          node.id,
          node.alias,
          profileSettingsTarget(profile),
        );
        return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
      }

      const requestedUploadPolicyIds = body.data.uploadPolicyIds ?? [];
      const uploadPolicyIds: string[] = [];

      if (requestedUploadPolicyIds.length === 0) {
        uploadPolicyIds.push((await uploadPolicyForQueue(undefined)).id);
      } else {
        for (const requestedPolicyId of requestedUploadPolicyIds) {
          const uploadPolicy = await findUploadPolicy(requestedPolicyId);

          if (!uploadPolicy) {
            await recordRecordingStartFailure(c, "upload_policy_not_found", node.id, node.alias);
            return c.json({ error: "Upload policy not found" }, 404);
          }

          if (!(await hasResourceScope(currentUser(c), uploadPolicySettingsTarget(uploadPolicy)))) {
            await recordRecordingStartFailure(
              c,
              "missing_resource_scope",
              node.id,
              node.alias,
              uploadPolicySettingsTarget(uploadPolicy),
            );
            return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
          }

          uploadPolicyIds.push(uploadPolicy.id);
        }
      }

      const retentionPolicyId =
        body.data.retentionPolicyId ?? defaultKeepControllerCacheRetentionPolicy.id;
      const retentionPolicy = body.data.retentionPolicyId
        ? await findRetentionPolicy(body.data.retentionPolicyId)
        : defaultKeepControllerCacheRetentionPolicy;

      if (!retentionPolicy) {
        await recordRecordingStartFailure(c, "retention_policy_not_found", node.id, node.alias);
        return c.json({ error: "Retention policy not found" }, 404);
      }

      if (
        body.data.retentionPolicyId &&
        !(await hasResourceScope(currentUser(c), retentionPolicySettingsTarget(retentionPolicy)))
      ) {
        await recordRecordingStartFailure(
          c,
          "missing_resource_scope",
          node.id,
          node.alias,
          retentionPolicySettingsTarget(retentionPolicy),
        );
        return c.json({ error: "Forbidden", permission: "recording:create" }, 403);
      }

      const capacityReservedJobs = (await listRecordingJobs()).filter(
        (job) => job.nodeId === node.id && capacityReservedRecordingJobStatuses.has(job.status),
      );
      const maxConcurrentRecordings = node.recordingCapacity?.maxConcurrentRecordings ?? 1;

      if (capacityReservedJobs.length >= maxConcurrentRecordings) {
        const activeJob = capacityReservedJobs[0];

        await recordRecordingStartFailure(c, "active_recording_job_exists", node.id, node.alias, {
          id: activeJob?.id,
          type: "recording_job",
        });
        return c.json(
          {
            error: "Recorder node already has an active recording job",
            activeJobCount: capacityReservedJobs.length,
            jobId: activeJob?.id,
            maxConcurrentRecordings,
            reason: "active_recording_job_exists",
          },
          409,
        );
      }

      const recording: RecordingSummary = {
        cached: false,
        durationSeconds: 0,
        folder: body.data.folder ?? defaultAdHocFolder(now, node),
        healthStatus: "unknown",
        id: `rec_${randomUUID()}`,
        name: body.data.name ?? defaultAdHocName(now, node),
        nodeId: node.id,
        recordedAt: now.toISOString(),
        recordingProfileId,
        retentionPolicyId,
        source: "ad_hoc",
        status: "recording",
        tags: uniqueTags(body.data.tags ?? ["ad-hoc", "voice"]),
        uploadPolicyIds,
      };

      await recordingStore.create(recording);
      const job = await createRecordingJob(
        recording,
        await recordingJobTargetOptions({
          captureBackend: body.data.captureBackend,
          captureInterfaceId: body.data.captureInterfaceId,
          node,
          recordingProfileId: recording.recordingProfileId,
          settingsStore,
        }),
      );

      await recordAuditEvent(c, {
        action: "recordings.start.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          jobId: job.id,
          recordingId: recording.id,
        },
        details: {
          captureBackend: body.data.captureBackend,
          captureInterfaceId: body.data.captureInterfaceId,
          jobCommand: job.command,
          jobStatus: job.status,
          profileId: recordingProfileId,
          source: recording.source,
        },
        outcome: "succeeded",
        permission: "recording:create",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.json({ data: recording, job }, 202);
    },
  );

  app.post(
    "/api/v1/recordings/:recordingId/stop",
    requirePermission("recording:control", "recordings.stop", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = await findScopedRecording(c, recordingId);

      if (!recording) {
        await recordAuditEvent(c, {
          action: "recordings.stop.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "recording:control",
          reason: "recording_not_found",
          target: {
            id: recordingId,
            type: "recording",
          },
        });

        return c.json({ error: "Recording not found" }, 404);
      }

      const before = {
        cached: recording.cached,
        status: recording.status,
      };
      const job = await stopRecordingJob(recording.id);

      recording.durationSeconds = Math.max(recording.durationSeconds, 1);
      recording.status = "completed";
      await recordingStore.save(recording);

      await recordAuditEvent(c, {
        action: "recordings.stop.succeeded",
        auth: currentAuth(c),
        after: {
          cached: recording.cached,
          status: recording.status,
        },
        before,
        correlationIds: {
          ...(job ? { jobId: job.id } : {}),
          recordingId: recording.id,
        },
        details: {
          jobStatus: job?.status ?? "no_active_job",
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.json({ data: recording });
    },
  );

  async function recordRecordingStartFailure(
    c: Context<AppBindings>,
    reason: string,
    nodeId?: string,
    nodeName?: string,
    target?: AuditTarget,
  ) {
    await recordAuditEvent(c, {
      action: "recordings.start.failed",
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission: "recording:create",
      reason,
      target: target ?? {
        id: nodeId,
        name: nodeName,
        type: "node",
      },
    });
  }

  async function recordBulkMetadataFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "recordings.metadata.bulk_update.failed",
      auth: currentAuth(c),
      details,
      outcome: reason === "recording_not_visible" ? "denied" : "failed",
      permission: "recording:edit",
      reason,
      target: {
        id: "recording_collection",
        type: "recording_collection",
      },
    });
  }

  async function recordSelectedExportFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "recordings.export_selected.failed",
      auth: currentAuth(c),
      details,
      outcome: reason === "recording_not_visible" ? "denied" : "failed",
      permission: "recording:read",
      reason,
      target: {
        id: "recording_collection",
        type: "recording_collection",
      },
    });
  }

  async function findScopedRecording(c: Context<AppBindings>, recordingId: string) {
    return (await scopedRecordings(currentUser(c))).find(
      (recording) => recording.id === recordingId,
    );
  }
}
