import type { Context, Hono } from "hono";

import {
  durationFromHeader,
  nodeActor,
  nodeHealthEventDetails,
  nodeHealthEventSchema,
  nodeHeartbeatChanged,
  nodeHeartbeatSchema,
  nodeHeartbeatSnapshot,
  recordingFileSnapshot,
} from "./agent-route-helpers.js";
import { createAgentRouteAuth } from "./agent-route-auth.js";
import { readBoundedBody, recordingCacheUploadMaxBytes } from "./agent-cache-upload-body.js";
import { nodeHealthEventScopeFailure } from "./agent-health-event-scope.js";
import { bearerToken } from "./auth-utils.js";
import { registerAgentChannelMapRoute } from "./agent-channel-map-route.js";
import { registerAgentClaimGroupRoute } from "./agent-claim-group-route.js";
import { registerAgentInventoryRoute } from "./agent-inventory-route.js";
import { registerAgentMeterFrameRoute } from "./agent-meter-frame-route.js";
import { registerAgentNodeConfigRoute } from "./agent-node-config-route.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { AppBindings, RecordAuditEvent } from "./http-types.js";
import type { ListenSessionStore } from "./listen-session-store.js";
import type { MeterFrameStore } from "./meter-store.js";
import { NodeStoreError, type NodeStore } from "./node-store.js";
import {
  cancelRecordingJob,
  claimRecordingJob,
  completeRecordingJob,
  failRecordingJob,
  heartbeatRecordingJob,
  nextRecordingJob,
} from "./recording-jobs.js";
import { agentCacheFileJobScope } from "./agent-job-recording-scope.js";
import {
  createAgentCacheUploads,
  parseChunkIndex,
  parseChunkTotal,
} from "./agent-cache-uploads.js";
import { markAgentJobTerminalRecording } from "./agent-job-terminal-recording.js";
import { applyStoredRendition, storeRecordingFile } from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { UploadDestinationStore } from "./upload-destinations.js";

interface AgentRouteDependencies {
  app: Hono<AppBindings>;
  healthEventStore: HealthEventStore;
  listenSessionStore?: ListenSessionStore;
  meterFrameStore: MeterFrameStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  scheduleStore?: ScheduleStore;
  settingsStore: SettingsStore;
  uploadDestinationStore: UploadDestinationStore;
}

export function registerAgentRoutes({
  app,
  healthEventStore,
  listenSessionStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  scheduleStore,
  settingsStore,
  uploadDestinationStore,
}: AgentRouteDependencies) {
  // Node authentication, job/recording scope authorization, and the audit/health
  // failure recorders live in their own module to keep this file under the LOC
  // guard; the factory closes over the route's stores + audit sink.
  const {
    authenticateNode,
    authorizeJobNode,
    authorizeJobRecording,
    recordJobSuccess,
    recordNodeCredentialFailure,
    recordRecordingFileFailure,
    syncAndFindRecording,
  } = createAgentRouteAuth({
    healthEventStore,
    nodeStore,
    recordAuditEvent,
    recordingStore,
  });
  // Cache-file upload fan-out (whole-recording + chunked) lives in its own module
  // to keep this file under the LOC guard; it closes over the stores plus the two
  // audit/health helpers above.
  const cacheUploads = createAgentCacheUploads({
    healthEventStore,
    recordAuditEvent,
    recordingStore,
    recordRecordingFileFailure,
    syncAndFindRecording,
    uploadDestinationStore,
  });
  registerAgentNodeConfigRoute({
    app,
    listenSessionStore,
    nodeStore,
    recordAuditEvent,
  });
  registerAgentMeterFrameRoute({
    app,
    meterFrameStore,
    nodeStore,
    recordAuditEvent,
  });
  registerAgentChannelMapRoute({
    app,
    nodeStore,
    recordAuditEvent,
    settingsStore,
  });
  registerAgentInventoryRoute({
    app,
    nodeStore,
    recordAuditEvent,
  });
  registerAgentClaimGroupRoute({
    app,
    nodeStore,
    recordAuditEvent,
    recordingStore,
  });

  app.post("/api/v1/nodes/:nodeId/heartbeat", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNode(
      c,
      "nodes.heartbeat",
      {
        id: nodeId,
        type: "node",
      },
      "node:control",
    );

    if (auth.response) {
      return auth.response;
    }

    if (auth.credential.nodeId !== nodeId) {
      await recordNodeCredentialFailure(c, "nodes.heartbeat.failed", "node_scope_denied", {
        actor: auth.credential,
        permission: "node:control",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    const body = nodeHeartbeatSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordNodeCredentialFailure(c, "nodes.heartbeat.failed", "invalid_request", {
        actor: auth.credential,
        permission: "node:control",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Invalid node heartbeat", issues: body.error.issues }, 400);
    }

    const before = await nodeStore.find(nodeId);
    const updated = await nodeStore.heartbeat(nodeId, body.data).catch(async (error: unknown) => {
      if (error instanceof NodeStoreError) {
        return error;
      }

      return new NodeStoreError("Node heartbeat failed", "database_unavailable");
    });

    if (updated instanceof NodeStoreError) {
      await recordNodeCredentialFailure(c, "nodes.heartbeat.failed", updated.code, {
        actor: auth.credential,
        permission: "node:control",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node heartbeat unavailable" }, 503);
    }

    if (!updated) {
      await recordNodeCredentialFailure(c, "nodes.heartbeat.failed", "node_not_found", {
        actor: auth.credential,
        permission: "node:control",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node not found" }, 404);
    }

    const changed = nodeHeartbeatChanged(before, updated);

    await recordAuditEvent(c, {
      action: "nodes.heartbeat.succeeded",
      actor: nodeActor(auth.credential),
      ...(changed
        ? { after: nodeHeartbeatSnapshot(updated), before: nodeHeartbeatSnapshot(before) }
        : {}),
      details: { changed, runtime: updated.runtime },
      outcome: "succeeded",
      permission: "node:control",
      target: { id: updated.id, name: updated.alias, type: "node" },
    });

    return c.json({ data: updated }, 202);
  });

  app.post("/api/v1/nodes/:nodeId/health-events", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNode(
      c,
      "nodes.health_events.sync",
      {
        id: nodeId,
        type: "node",
      },
      "health:acknowledge",
    );

    if (auth.response) {
      return auth.response;
    }

    if (auth.credential.nodeId !== nodeId) {
      await recordNodeCredentialFailure(c, "nodes.health_events.sync.failed", "node_scope_denied", {
        actor: auth.credential,
        permission: "health:acknowledge",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    const body = nodeHealthEventSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordNodeCredentialFailure(c, "nodes.health_events.sync.failed", "invalid_request", {
        actor: auth.credential,
        permission: "health:acknowledge",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Invalid node health event", issues: body.error.issues }, 400);
    }

    const scopeFailure = await nodeHealthEventScopeFailure(body.data, {
      credential: auth.credential,
      recordingStore,
      scheduleStore,
    });

    if (scopeFailure) {
      await recordNodeCredentialFailure(c, "nodes.health_events.sync.failed", scopeFailure.reason, {
        actor: auth.credential,
        permission: "health:acknowledge",
        target: scopeFailure.target,
      });
      return c.json({ error: scopeFailure.error }, scopeFailure.status);
    }

    const event = await healthEventStore.create({
      details: nodeHealthEventDetails(body.data),
      nodeId,
      openedAt: body.data.openedAt ? new Date(body.data.openedAt) : undefined,
      recordingId: body.data.recordingId,
      scheduleId: body.data.scheduleId,
      severity: body.data.severity,
      type: body.data.type,
    });

    await syncRecordingHealth(healthEventStore, recordingStore, event.recordingId);
    await recordAuditEvent(c, {
      action: "nodes.health_events.sync.succeeded",
      actor: nodeActor(auth.credential),
      after: {
        healthEventId: event.id,
        recordingId: event.recordingId,
        scheduleId: event.scheduleId,
        severity: event.severity,
        type: event.type,
      },
      details: {
        localEventId: body.data.id,
      },
      outcome: "succeeded",
      permission: "health:acknowledge",
      target: { id: event.id, name: event.type, type: "health_event" },
    });

    return c.json({ data: event }, 201);
  });

  app.get("/api/v1/nodes/:nodeId/recording-jobs/next", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNode(c, "recording_jobs.next", { id: nodeId, type: "node" });

    if (auth.response) {
      return auth.response;
    }

    if (auth.credential.nodeId !== nodeId) {
      await recordNodeCredentialFailure(c, "recording_jobs.next.failed", "node_scope_denied", {
        actor: auth.credential,
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    const job = await nextRecordingJob(nodeId);

    await recordAuditEvent(c, {
      action: "recording_jobs.next.succeeded",
      actor: nodeActor(auth.credential),
      correlationIds: job ? { recordingId: job.recordingId, recordingJobId: job.id } : undefined,
      details: {
        queued: Boolean(job),
        ...(job
          ? {
              recordingId: job.recordingId,
              recordingJobId: job.id,
              status: job.status,
            }
          : {}),
      },
      outcome: "succeeded",
      permission: "recording:control",
      target: { id: nodeId, type: "node" },
    });

    return job ? c.json({ data: job }) : c.body(null, 204);
  });

  app.post("/api/v1/nodes/:nodeId/recording-jobs/claim-next", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNode(c, "recording_jobs.claim_next", {
      id: nodeId,
      type: "node",
    });

    if (auth.response) {
      return auth.response;
    }

    if (auth.credential.nodeId !== nodeId) {
      await recordNodeCredentialFailure(
        c,
        "recording_jobs.claim_next.failed",
        "node_scope_denied",
        {
          actor: auth.credential,
          target: { id: nodeId, type: "node" },
        },
      );
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    while (true) {
      const nextJob = await nextRecordingJob(nodeId);

      if (!nextJob) {
        await recordAuditEvent(c, {
          action: "recording_jobs.claim_next.succeeded",
          actor: nodeActor(auth.credential),
          details: { claimed: false },
          outcome: "succeeded",
          permission: "recording:control",
          target: { id: nodeId, type: "node" },
        });
        return c.body(null, 204);
      }

      const nextRecording = await authorizeJobRecording(
        c,
        auth.credential,
        nextJob,
        "recording_jobs.claim_next",
      );

      if (nextRecording.response) {
        return nextRecording.response;
      }

      const job = await claimRecordingJob(nextJob.id, auth.credential.nodeId);

      if (!job) {
        continue;
      }

      nextRecording.recording.status = "recording";
      await recordingStore.save(nextRecording.recording);
      await recordJobSuccess(c, "recording_jobs.claim_next.succeeded", auth.credential, job);

      return c.json({ data: job });
    }
  });

  app.post("/api/v1/recording-jobs/:jobId/claim", async (c) => {
    const jobId = c.req.param("jobId");
    const auth = await authenticateNode(c, "recording_jobs.claim", {
      id: jobId,
      type: "recording_job",
    });

    if (auth.response) {
      return auth.response;
    }

    const existing = await authorizeJobNode(c, auth.credential, jobId, "recording_jobs.claim");

    if (existing.response) {
      return existing.response;
    }

    const existingRecording = await authorizeJobRecording(
      c,
      auth.credential,
      existing.job,
      "recording_jobs.claim",
    );

    if (existingRecording.response) {
      return existingRecording.response;
    }

    const job = await claimRecordingJob(jobId, auth.credential.nodeId);

    if (!job) {
      await recordNodeCredentialFailure(c, "recording_jobs.claim.failed", "job_not_claimable", {
        actor: auth.credential,
        target: { id: jobId, type: "recording_job" },
      });
      return c.json({ error: "Recording job is not claimable" }, 409);
    }

    existingRecording.recording.status = "recording";
    await recordingStore.save(existingRecording.recording);
    await recordJobSuccess(c, "recording_jobs.claim.succeeded", auth.credential, job);

    return c.json({ data: job });
  });

  app.post("/api/v1/recording-jobs/:jobId/heartbeat", async (c) => {
    const jobId = c.req.param("jobId");
    const auth = await authenticateNode(c, "recording_jobs.heartbeat", {
      id: jobId,
      type: "recording_job",
    });

    if (auth.response) {
      return auth.response;
    }

    const existing = await authorizeJobNode(c, auth.credential, jobId, "recording_jobs.heartbeat");

    if (existing.response) {
      return existing.response;
    }

    const job = await heartbeatRecordingJob(jobId, auth.credential.nodeId);

    if (!job) {
      await recordNodeCredentialFailure(
        c,
        "recording_jobs.heartbeat.failed",
        "job_not_heartbeatable",
        {
          actor: auth.credential,
          target: { id: jobId, type: "recording_job" },
        },
      );
      return c.json({ error: "Recording job is not heartbeatable" }, 409);
    }

    await recordJobSuccess(c, "recording_jobs.heartbeat.succeeded", auth.credential, job);

    return c.json({ data: job });
  });

  app.get("/api/v1/recording-jobs/:jobId", async (c, next) => {
    const jobId = c.req.param("jobId");

    // `/api/v1/recording-jobs/export` is a static operator route that collides
    // with this `:jobId` param route under Hono's TrieRouter (the app falls back
    // to TrieRouter because of the nodes static+param collision — see audit G1).
    // This node-auth handler is registered first, so without this guard it would
    // answer `/export` with a node-credential 401 instead of the operator export
    // handler. A real job id is never the literal "export", so defer it downstream.
    if (jobId === "export") {
      await next();
      return c.res;
    }

    const token = bearerToken(c.req.header("authorization"));

    if (!token)
      return (
        await authenticateNode(c, "recording_jobs.read_one", { id: jobId, type: "recording_job" })
      ).response;

    const credential = await nodeStore.authenticateCredential(token).catch(async () => undefined);

    if (!credential) {
      await next();
      return c.res;
    }

    const existing = await authorizeJobNode(c, credential, jobId, "recording_jobs.read_one");

    if (!existing.response) {
      await recordAuditEvent(c, {
        action: "recording_jobs.read_one.succeeded",
        actor: nodeActor(credential),
        correlationIds: {
          recordingId: existing.job.recordingId,
          recordingJobId: existing.job.id,
        },
        details: {
          nodeId: existing.job.nodeId,
          recordingId: existing.job.recordingId,
          status: existing.job.status,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: { id: existing.job.id, type: "recording_job" },
      });
    }

    return existing.response ?? c.json({ data: existing.job });
  });

  app.post("/api/v1/recording-jobs/:jobId/cancelled", async (c) =>
    updateJobTerminal(c, "cancelled"),
  );

  app.post("/api/v1/recording-jobs/:jobId/failed", async (c) => updateJobTerminal(c, "failed"));

  app.put("/api/v1/recordings/:recordingId/cache-file", async (c) => {
    const recordingId = c.req.param("recordingId");
    const auth = await authenticateNode(c, "recordings.cache_file.attach", {
      id: recordingId,
      type: "recording",
    });

    if (auth.response) {
      return auth.response;
    }

    const recording = await recordingStore.find(recordingId);

    if (!recording) {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        reason: "recording_not_found",
        recordingId,
      });
      return c.json({ error: "Recording not found" }, 404);
    }

    if (recording.nodeId !== auth.credential.nodeId) {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        reason: "node_scope_denied",
        recordingId,
        targetName: recording.name,
      });
      return c.json({ error: "Node credential cannot access this recording" }, 403);
    }

    const maxUploadBytes = recordingCacheUploadMaxBytes();
    const declaredLength = Number(c.req.header("content-length"));

    // Fast path: reject an over-cap upload from its declared Content-Length before
    // buffering a byte (the streaming read below is the backstop for a chunked
    // body that omits or lies about it).
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        createHealthEvent: true,
        reason: "file_too_large",
        recordingId,
        severity: "warning",
        targetName: recording.name,
      });
      return c.json({ error: "Recording cache file exceeds the maximum size" }, 413);
    }

    // The controller already decided this recording terminally failed (e.g. a
    // lease expiry with no secured chunks). A late/replayed cache upload must
    // not silently resurrect it back to `cached` via applyStoredRendition.
    if (recording.status === "failed") {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        reason: "recording_terminal_failed",
        recordingId,
        targetName: recording.name,
      });
      return c.json({ error: "Recording is in a terminal failed state" }, 409);
    }

    const jobId = c.req.header("x-rakkr-recording-job-id");
    const scopedJob = await agentCacheFileJobScope(
      { jobId },
      { credential: auth.credential, recording },
    );

    if (!scopedJob.ok) {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        jobId,
        reason: scopedJob.reason,
        recordingId,
        target: scopedJob.target,
        targetName: recording.name,
      });
      return c.json({ error: scopedJob.error }, scopedJob.status);
    }

    const body = await readBoundedBody(c.req.raw, maxUploadBytes);

    if (body === "too_large") {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        createHealthEvent: true,
        reason: "file_too_large",
        recordingId,
        severity: "warning",
        targetName: recording.name,
      });
      return c.json({ error: "Recording cache file exceeds the maximum size" }, 413);
    }

    const bytes = Buffer.from(body);

    if (bytes.byteLength === 0) {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        createHealthEvent: true,
        jobId,
        reason: "empty_file",
        recordingId,
        severity: "critical",
        targetName: recording.name,
      });
      return c.json({ error: "Recording cache file cannot be empty" }, 400);
    }

    const durationSeconds = durationFromHeader(c.req.header("x-rakkr-duration-seconds"));

    if (durationSeconds === "invalid") {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        createHealthEvent: true,
        jobId,
        reason: "invalid_duration",
        recordingId,
        severity: "warning",
        targetName: recording.name,
      });
      return c.json({ error: "Invalid x-rakkr-duration-seconds header" }, 400);
    }

    const renditionParam = c.req.query("rendition");
    const rendition =
      renditionParam === "raw" || renditionParam === "enhanced" ? renditionParam : undefined;

    const chunkIndex = parseChunkIndex(c.req.query("chunk"));

    if (chunkIndex === "invalid") {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        createHealthEvent: true,
        jobId,
        reason: "invalid_chunk_index",
        recordingId,
        severity: "warning",
        targetName: recording.name,
      });
      return c.json({ error: "Invalid chunk query parameter" }, 400);
    }

    if (chunkIndex !== undefined) {
      return cacheUploads.handleChunkUpload(c, {
        actor: auth.credential,
        bytes,
        // Wire index is 0-based; chunk rows and storage use 1-based indices.
        chunkIndex: chunkIndex + 1,
        chunkTotal: parseChunkTotal(c.req.query("chunkTotal")),
        durationSeconds,
        fileName: c.req.header("x-rakkr-file-name"),
        job: scopedJob.job,
        jobId,
        mimeType: c.req.header("content-type"),
        recording,
        rendition,
      });
    }

    const before = recordingFileSnapshot(recording);
    const stored = await storeRecordingFile(
      recording,
      {
        bytes,
        fileName: c.req.header("x-rakkr-file-name"),
        mimeType: c.req.header("content-type"),
      },
      rendition,
    ).catch(async (error: unknown) => {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        createHealthEvent: true,
        jobId,
        reason: error instanceof Error ? error.message : "cache_write_failed",
        recordingId,
        severity: "critical",
        targetName: recording.name,
      });
      throw error;
    });
    // The raw rendition is supplementary (no job completion or cloud queue).
    const supplementary = applyStoredRendition(recording, stored, rendition, durationSeconds);
    await recordingStore.save(recording);
    const job =
      !supplementary && scopedJob.job
        ? await completeRecordingJob(recording.id, scopedJob.job.id)
        : undefined;
    const uploadQueueItems = supplementary
      ? []
      : await cacheUploads.queueCachedRecordingUpload(c, auth.credential, recording);
    const uploadQueueItem = uploadQueueItems[0];
    const syncedRecording = await syncAndFindRecording(recording);

    await recordAuditEvent(c, {
      action: "recordings.cache_file.attach.succeeded",
      actor: nodeActor(auth.credential),
      after: recordingFileSnapshot(syncedRecording),
      before,
      details: {
        cachePath: stored.cachePath,
        checksum: stored.checksum,
        fileName: stored.fileName,
        jobId,
        jobStatus: job?.status,
        mimeType: stored.mimeType,
        rendition: rendition ?? "primary",
        size: stored.size,
        uploadQueueItemId: uploadQueueItem?.id,
        uploadQueueItemIds: uploadQueueItems.map((item) => item.id),
        waveformPeaks: stored.waveformPreview?.peaks.length,
      },
      outcome: "succeeded",
      permission: "recording:control",
      target: {
        id: recording.id,
        name: recording.name,
        type: "recording",
      },
    });

    return c.json(
      { data: { file: stored, recording: syncedRecording, uploadQueueItem, uploadQueueItems } },
      201,
    );
  });

  async function updateJobTerminal(c: Context<AppBindings>, terminalState: "cancelled" | "failed") {
    const jobId = c.req.param("jobId");

    if (!jobId) {
      return c.json({ error: "Recording job id is required" }, 400);
    }

    const auth = await authenticateNode(c, `recording_jobs.${terminalState}`, {
      id: jobId,
      type: "recording_job",
    });

    if (auth.response) {
      return auth.response;
    }

    const existing = await authorizeJobNode(
      c,
      auth.credential,
      jobId,
      `recording_jobs.${terminalState}`,
    );

    if (existing.response) {
      return existing.response;
    }

    const existingRecording = await authorizeJobRecording(
      c,
      auth.credential,
      existing.job,
      `recording_jobs.${terminalState}`,
    );

    if (existingRecording.response) {
      return existingRecording.response;
    }

    const reason = c.req.header("x-rakkr-reason") ?? `agent_${terminalState}`;
    const job =
      terminalState === "cancelled"
        ? await cancelRecordingJob(jobId, reason)
        : await failRecordingJob(jobId, reason);

    if (!job || job.nodeId !== auth.credential.nodeId) {
      return c.json({ error: "Recording job not found" }, 404);
    }

    const recording = await markAgentJobTerminalRecording(
      existingRecording.recording,
      {
        jobId: job.id,
        reason,
        terminalState,
      },
      { healthEventStore, recordingStore },
    );

    await recordJobSuccess(c, `recording_jobs.${terminalState}.succeeded`, auth.credential, job, {
      healthEventId: recording?.healthEventId,
      reason: job.failureReason,
      recordingStatus: recording?.status,
    });

    return c.json({ data: job });
  }
}
