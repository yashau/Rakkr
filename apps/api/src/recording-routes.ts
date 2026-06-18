import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  defaultVoiceRecordingProfile,
  type Permission,
  type RecordingSummary,
  recordingStatusSchema,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import { recordingJobTargetOptions } from "./recording-job-targets.js";
import { createRecordingJob, listRecordingJobs, stopRecordingJob } from "./recording-jobs.js";
import { loadRecordingFile, recordingFileName, recordingHasCachedFile } from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import type { SettingsStore } from "./settings-store.js";

interface RecordingRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
  settingsStore: SettingsStore;
}

const recordingMetadataUpdateSchema = z
  .object({
    folder: z.string().trim().min(1).max(240).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(32).optional(),
  })
  .strict()
  .refine(
    (value) => value.folder !== undefined || value.name !== undefined || value.tags !== undefined,
    "Expected at least one metadata field",
  );

const optionalTextFilterSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().trim().max(240).optional(),
);

const recordingsQuerySchema = z.object({
  folder: optionalTextFilterSchema,
  healthStatus: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.enum(["healthy", "warning", "critical", "unknown"]).optional(),
  ),
  nodeId: optionalTextFilterSchema,
  scheduleId: optionalTextFilterSchema,
  search: optionalTextFilterSchema,
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    recordingStatusSchema.optional(),
  ),
  tag: optionalTextFilterSchema,
});

type RecordingsQuery = z.infer<typeof recordingsQuerySchema>;

export function registerRecordingRoutes({
  app,
  currentAuth,
  currentUser,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scopedRecordings,
  settingsStore,
}: RecordingRouteDependencies) {
  const recordRecordingFileFailure = async (
    c: Context<AppBindings>,
    input: {
      action: string;
      permission: Permission;
      reason: string;
      recordingId: string;
      targetName?: string;
    },
  ) =>
    recordAuditEvent(c, {
      action: input.action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: input.permission,
      reason: input.reason,
      target: {
        id: input.recordingId,
        name: input.targetName,
        type: "recording",
      },
    });

  async function serveRecordingFile(
    c: Context<AppBindings>,
    recordingId: string,
    disposition: "attachment" | "inline",
    permission: Permission,
  ) {
    const recording = await recordingStore.find(recordingId);
    const action =
      disposition === "attachment" ? "recordings.download.file" : "recordings.playback.stream";

    if (!recording || !recordingHasCachedFile(recording)) {
      await recordRecordingFileFailure(c, {
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
      const file = await loadRecordingFile(recording);

      await recordAuditEvent(c, {
        action: `${action}.succeeded`,
        auth: currentAuth(c),
        details: {
          disposition,
          fileName: file.fileName,
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
      await recordRecordingFileFailure(c, {
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
    "/api/v1/recordings",
    requirePermission("recording:read", "recordings.read"),
    async (c) => {
      const query = recordingsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid recording filters", issues: query.error.issues }, 400);
      }

      return c.json({
        data: filterRecordings(await scopedRecordings(currentUser(c)), query.data),
      });
    },
  );

  app.get(
    "/api/v1/recording-jobs",
    requirePermission("recording:read", "recording_jobs.read"),
    async (c) => {
      const visibleRecordingIds = new Set(
        (await scopedRecordings(currentUser(c))).map((recording) => recording.id),
      );
      const jobs = await listRecordingJobs();

      return c.json({
        data: jobs.filter((job) => visibleRecordingIds.has(job.recordingId)),
      });
    },
  );

  app.post(
    "/api/v1/recordings/:recordingId/playback",
    requirePermission("recording:playback", "recordings.playback.start", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = await recordingStore.find(recordingId);

      if (!recording || !recordingHasCachedFile(recording)) {
        await recordRecordingFileFailure(c, {
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
      const recording = await recordingStore.find(recordingId);

      if (!recording || !recordingHasCachedFile(recording)) {
        await recordRecordingFileFailure(c, {
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

      const recording = await recordingStore.find(recordingId);

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
      const updated: RecordingSummary = {
        ...recording,
        folder: body.data.folder ?? recording.folder,
        name: body.data.name ?? recording.name,
        tags: body.data.tags ? uniqueTags(body.data.tags) : recording.tags,
      };

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

  app.post(
    "/api/v1/recordings",
    requirePermission("recording:create", "recordings.start", () => ({
      id: "node_x32_test",
      name: "Council Chamber Rack",
      type: "node",
    })),
    async (c) => {
      const now = new Date();
      const recording: RecordingSummary = {
        cached: false,
        durationSeconds: 0,
        folder: `Ad Hoc/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
        healthStatus: "unknown",
        id: `rec_${randomUUID()}`,
        name: `${now.toISOString().slice(0, 16).replace("T", "_")}_Ad Hoc_Council Chamber Rack`,
        nodeId: "node_x32_test",
        recordedAt: now.toISOString(),
        recordingProfileId: defaultVoiceRecordingProfile.id,
        source: "ad_hoc",
        status: "recording",
        tags: ["ad-hoc", "voice"],
      };

      await recordingStore.create(recording);
      const node = await nodeStore.find(recording.nodeId ?? "node_x32_test");
      const job = await createRecordingJob(
        recording,
        await recordingJobTargetOptions({ node, settingsStore }),
      );

      await recordAuditEvent(c, {
        action: "recordings.start.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          jobId: job.id,
          recordingId: recording.id,
        },
        details: {
          jobCommand: job.command,
          jobStatus: job.status,
          profileId: defaultVoiceRecordingProfile.id,
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
      const recording = await recordingStore.find(recordingId);

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
}

function recordingMetadataSnapshot(recording: RecordingSummary) {
  return {
    folder: recording.folder,
    name: recording.name,
    tags: recording.tags,
  };
}

function filterRecordings(recordings: RecordingSummary[], filters: RecordingsQuery) {
  return recordings.filter((recording) => {
    if (filters.folder && !includesText(recording.folder, filters.folder)) {
      return false;
    }

    if (filters.healthStatus && recording.healthStatus !== filters.healthStatus) {
      return false;
    }

    if (filters.nodeId && recording.nodeId !== filters.nodeId) {
      return false;
    }

    if (filters.scheduleId && recording.scheduleId !== filters.scheduleId) {
      return false;
    }

    if (filters.search && !recordingMatchesSearch(recording, filters.search)) {
      return false;
    }

    if (filters.status && recording.status !== filters.status) {
      return false;
    }

    return (
      !filters.tag ||
      recording.tags.some((tag) => tag.toLocaleLowerCase() === filters.tag?.toLocaleLowerCase())
    );
  });
}

function recordingMatchesSearch(recording: RecordingSummary, search: string) {
  const searchableValues = [
    recording.folder,
    recording.id,
    recording.name,
    recording.nodeId,
    recording.scheduleId,
    recording.source,
    recording.status,
    ...recording.tags,
  ];

  return searchableValues.some((value) => value && includesText(value, search));
}

function includesText(value: string, search: string) {
  return value.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

function uniqueTags(tags: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    const key = tag.toLocaleLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }

  return result;
}
