import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  defaultVoiceRecordingProfile,
  type Permission,
  type RecordingSummary,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import {
  loadRecordingFile,
  recordingFileName,
  recordingHasCachedFile,
  storeRecordingFile,
} from "./recording-cache.js";

interface RecordingRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  recordings: RecordingSummary[];
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => RecordingSummary[];
}

export function registerRecordingRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  recordings,
  requirePermission,
  scopedRecordings,
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
    const recording = recordings.find((candidate) => candidate.id === recordingId);
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

  app.get("/api/v1/recordings", requirePermission("recording:read", "recordings.read"), (c) =>
    c.json({ data: scopedRecordings(currentUser(c)) }),
  );

  app.post(
    "/api/v1/recordings/:recordingId/playback",
    requirePermission("recording:playback", "recordings.playback.start", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = recordings.find((candidate) => candidate.id === recordingId);

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
      const recording = recordings.find((candidate) => candidate.id === recordingId);

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
        source: "ad_hoc",
        status: "recording",
        tags: ["ad-hoc", "voice"],
      };

      recordings.unshift(recording);

      await recordAuditEvent(c, {
        action: "recordings.start.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          recordingId: recording.id,
        },
        details: {
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

      return c.json({ data: recording }, 202);
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
      const recording = recordings.find((candidate) => candidate.id === recordingId);

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

      recording.durationSeconds = Math.max(recording.durationSeconds, 1);
      recording.status = "completed";

      await recordAuditEvent(c, {
        action: "recordings.stop.succeeded",
        auth: currentAuth(c),
        after: {
          cached: recording.cached,
          status: recording.status,
        },
        before,
        correlationIds: {
          recordingId: recording.id,
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

  app.put(
    "/api/v1/recordings/:recordingId/cache-file",
    requirePermission("recording:control", "recordings.cache_file.attach", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = recordings.find((candidate) => candidate.id === recordingId);

      if (!recording) {
        await recordRecordingFileFailure(c, {
          action: "recordings.cache_file.attach.failed",
          permission: "recording:control",
          reason: "recording_not_found",
          recordingId,
        });

        return c.json({ error: "Recording not found" }, 404);
      }

      const bytes = Buffer.from(await c.req.arrayBuffer());

      if (bytes.byteLength === 0) {
        await recordRecordingFileFailure(c, {
          action: "recordings.cache_file.attach.failed",
          permission: "recording:control",
          reason: "empty_file",
          recordingId,
          targetName: recording.name,
        });

        return c.json({ error: "Recording cache file cannot be empty" }, 400);
      }

      const durationSeconds = durationFromHeader(c.req.header("x-rakkr-duration-seconds"));

      if (durationSeconds === "invalid") {
        await recordRecordingFileFailure(c, {
          action: "recordings.cache_file.attach.failed",
          permission: "recording:control",
          reason: "invalid_duration",
          recordingId,
          targetName: recording.name,
        });

        return c.json({ error: "Invalid x-rakkr-duration-seconds header" }, 400);
      }

      const before = {
        cachePath: recording.cachePath,
        cached: recording.cached,
        durationSeconds: recording.durationSeconds,
        status: recording.status,
      };
      const stored = await storeRecordingFile(recording, {
        bytes,
        fileName: c.req.header("x-rakkr-file-name"),
        mimeType: c.req.header("content-type"),
      }).catch(async (error: unknown) => {
        await recordRecordingFileFailure(c, {
          action: "recordings.cache_file.attach.failed",
          permission: "recording:control",
          reason: error instanceof Error ? error.message : "cache_write_failed",
          recordingId,
          targetName: recording.name,
        });

        throw error;
      });

      recording.cached = true;
      recording.cachePath = stored.cachePath;
      recording.durationSeconds = durationSeconds ?? Math.max(recording.durationSeconds, 1);
      recording.status = "cached";

      await recordAuditEvent(c, {
        action: "recordings.cache_file.attach.succeeded",
        after: {
          cachePath: recording.cachePath,
          cached: recording.cached,
          durationSeconds: recording.durationSeconds,
          status: recording.status,
        },
        auth: currentAuth(c),
        before,
        details: {
          cachePath: stored.cachePath,
          fileName: stored.fileName,
          mimeType: stored.mimeType,
          size: stored.size,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return c.json({ data: { file: stored, recording } }, 201);
    },
  );
}

function durationFromHeader(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return "invalid";
  }

  return Math.floor(parsed);
}
