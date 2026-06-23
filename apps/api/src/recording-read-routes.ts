import type { Context, Hono } from "hono";
import type { RecordingSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import {
  filterRecordings,
  paginateRecordings,
  recordingFacets,
  recordingsQuerySchema,
} from "./recording-listing.js";
import { listRecordingJobs } from "./recording-jobs.js";
import { createRecordingRouteAudit } from "./recording-route-audit.js";
import { listUploadQueueItems } from "./upload-queue.js";

interface RecordingReadRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  healthEventStore?: HealthEventStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
}

export function registerRecordingReadRoutes({
  app,
  currentAuth,
  currentUser,
  healthEventStore,
  recordAuditEvent,
  requirePermission,
  scopedRecordings,
}: RecordingReadRouteDependencies) {
  const recordingAudit = createRecordingRouteAudit({ currentAuth, recordAuditEvent });

  app.get(
    "/api/v1/recordings",
    requirePermission("recording:read", "recordings.read"),
    async (c) => {
      const query = recordingsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        await recordingAudit.readFailure(c, {
          action: "recordings.read.failed",
          details: { issueCount: query.error.issues.length },
          reason: "invalid_filters",
        });
        return c.json({ error: "Invalid recording filters", issues: query.error.issues }, 400);
      }

      const filtered = filterRecordings(await scopedRecordings(currentUser(c)), query.data);
      const page = paginateRecordings(filtered, query.data);

      await recordingAudit.collectionSucceeded(c, {
        action: "recordings.read.succeeded",
        details: {
          filters: query.data,
          returnedCount: page.meta.returned,
          totalCount: page.meta.total,
        },
      });

      return c.json(page);
    },
  );

  app.get(
    "/api/v1/recordings/facets",
    requirePermission("recording:read", "recordings.facets.read"),
    async (c) => {
      const recordings = await scopedRecordings(currentUser(c));
      const facets = recordingFacets(recordings);

      await recordingAudit.collectionSucceeded(c, {
        action: "recordings.facets.read.succeeded",
        details: {
          folderCount: facets.folders.length,
          nodeCount: facets.nodes.length,
          recordingCount: recordings.length,
          tagCount: facets.tags.length,
        },
      });

      return c.json({ data: facets });
    },
  );

  app.get(
    "/api/v1/recordings/:recordingId",
    requirePermission("recording:read", "recordings.detail.read", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = (await scopedRecordings(currentUser(c))).find(
        (candidate) => candidate.id === recordingId,
      );

      if (!recording) {
        await recordingAudit.readFailure(c, {
          action: "recordings.detail.read.failed",
          reason: "recording_not_found",
          recordingId,
        });
        return c.json({ error: "Recording not found" }, 404);
      }

      await recordingAudit.recordingSucceeded(c, {
        action: "recordings.detail.read.succeeded",
        details: {
          healthStatus: recording.healthStatus,
          source: recording.source,
          status: recording.status,
        },
        recording,
      });

      return c.json({ data: recording });
    },
  );

  app.get(
    "/api/v1/recordings/:recordingId/context",
    requirePermission("recording:read", "recordings.context.read", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const recording = (await scopedRecordings(currentUser(c))).find(
        (candidate) => candidate.id === recordingId,
      );

      if (!recording) {
        await recordingAudit.readFailure(c, {
          action: "recordings.context.read.failed",
          reason: "recording_not_found",
          recordingId,
        });
        return c.json({ error: "Recording not found" }, 404);
      }

      const [jobs, healthEvents, uploadQueueItems] = await Promise.all([
        listRecordingJobs(),
        healthEventStore?.list({ limit: 100, recordingId }) ?? [],
        listUploadQueueItems(),
      ]);
      const recordingJobs = jobs.filter((job) => job.recordingId === recording.id);
      const recordingUploadQueueItems = uploadQueueItems.filter(
        (item) => item.recordingId === recording.id,
      );

      await recordingAudit.recordingSucceeded(c, {
        action: "recordings.context.read.succeeded",
        details: {
          healthEventCount: healthEvents.length,
          jobCount: recordingJobs.length,
          uploadQueueItemCount: recordingUploadQueueItems.length,
        },
        recording,
      });

      return c.json({
        data: {
          healthEvents,
          jobs: recordingJobs,
          recording,
          uploadQueueItems: recordingUploadQueueItems,
        },
      });
    },
  );
}
