import type { Context, Hono } from "hono";
import { meterFrameSchema, type RecordingSummary } from "@rakkr/shared";

import {
  assignedChannelMaps,
  durationFromHeader,
  nodeActor,
  nodeHealthEventDetails,
  nodeHealthEventSchema,
  nodeHeartbeatChanged,
  nodeHeartbeatSchema,
  nodeHeartbeatSnapshot,
  recordingFileSnapshot,
} from "./agent-route-helpers.js";
import { bearerToken } from "./auth-utils.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { MeterFrameStore } from "./meter-store.js";
import { NodeStoreError, type NodeCredentialAuth, type NodeStore } from "./node-store.js";
import {
  cancelRecordingJob,
  claimRecordingJob,
  completeRecordingJob,
  failRecordingJob,
  heartbeatRecordingJob,
  nextRecordingJob,
  recordingJob,
} from "./recording-jobs.js";
import { storeRecordingFile } from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import type { SettingsStore } from "./settings-store.js";
import { uploadPolicyForCachedRecording, uploadQueueInputForPolicy } from "./upload-policies.js";
import { enqueueRecordingUpload } from "./upload-queue.js";

interface AgentRouteDependencies {
  app: Hono<AppBindings>;
  healthEventStore: HealthEventStore;
  meterFrameStore: MeterFrameStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  settingsStore: SettingsStore;
}

type AuthenticatedNode =
  | { credential: NodeCredentialAuth; response?: never }
  | { credential?: never; response: Response };
type NodeServicePermission = "health:acknowledge" | "node:control" | "recording:control";

export function registerAgentRoutes({
  app,
  healthEventStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  settingsStore,
}: AgentRouteDependencies) {
  app.get("/api/v1/nodes/:nodeId/channel-map-assignments", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNode(
      c,
      "nodes.channel_map_assignments.read",
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
      await recordNodeCredentialFailure(
        c,
        "nodes.channel_map_assignments.read.failed",
        "node_scope_denied",
        {
          actor: auth.credential,
          permission: "node:control",
          target: { id: nodeId, type: "node" },
        },
      );
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    const node = await nodeStore.find(nodeId);

    if (!node) {
      await recordNodeCredentialFailure(
        c,
        "nodes.channel_map_assignments.read.failed",
        "node_not_found",
        {
          actor: auth.credential,
          permission: "node:control",
          target: { id: nodeId, type: "node" },
        },
      );
      return c.json({ error: "Node not found" }, 404);
    }

    const assignments = await assignedChannelMaps(node, settingsStore);

    await recordAuditEvent(c, {
      action: "nodes.channel_map_assignments.read.succeeded",
      actor: nodeActor(auth.credential),
      details: {
        assignmentCount: assignments.length,
      },
      outcome: "succeeded",
      permission: "node:control",
      target: {
        id: nodeId,
        type: "node",
      },
    });

    return c.json({ data: assignments });
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

    if (nodeHeartbeatChanged(before, updated)) {
      await recordAuditEvent(c, {
        action: "nodes.heartbeat.succeeded",
        actor: nodeActor(auth.credential),
        after: nodeHeartbeatSnapshot(updated),
        before: nodeHeartbeatSnapshot(before),
        details: {
          runtime: updated.runtime,
        },
        outcome: "succeeded",
        permission: "node:control",
        target: {
          id: updated.id,
          name: updated.alias,
          type: "node",
        },
      });
    }

    return c.json({ data: updated }, 202);
  });

  app.post("/api/v1/nodes/:nodeId/meter-frame", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNode(
      c,
      "nodes.meter_frame.ingest",
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
      await recordNodeCredentialFailure(c, "nodes.meter_frame.ingest.failed", "node_scope_denied", {
        actor: auth.credential,
        permission: "node:control",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    const body = meterFrameSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordNodeCredentialFailure(c, "nodes.meter_frame.ingest.failed", "invalid_request", {
        actor: auth.credential,
        permission: "node:control",
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Invalid meter frame", issues: body.error.issues }, 400);
    }

    if (body.data.nodeId !== nodeId || body.data.nodeId !== auth.credential.nodeId) {
      await recordNodeCredentialFailure(c, "nodes.meter_frame.ingest.failed", "node_scope_denied", {
        actor: auth.credential,
        permission: "node:control",
        target: { id: body.data.nodeId, type: "node" },
      });
      return c.json({ error: "Meter frame node mismatch" }, 403);
    }

    const stored = await meterFrameStore.save(body.data);

    return c.json({ data: stored }, 202);
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

    if (body.data.recordingId) {
      const recording = await recordingStore.find(body.data.recordingId);

      if (!recording) {
        await recordNodeCredentialFailure(
          c,
          "nodes.health_events.sync.failed",
          "recording_not_found",
          {
            actor: auth.credential,
            permission: "health:acknowledge",
            target: { id: body.data.recordingId, type: "recording" },
          },
        );
        return c.json({ error: "Recording not found" }, 404);
      }

      if (recording.nodeId !== auth.credential.nodeId) {
        await recordNodeCredentialFailure(
          c,
          "nodes.health_events.sync.failed",
          "node_scope_denied",
          {
            actor: auth.credential,
            permission: "health:acknowledge",
            target: { id: body.data.recordingId, type: "recording" },
          },
        );
        return c.json({ error: "Node credential cannot access this recording" }, 403);
      }
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
      target: {
        id: event.id,
        name: event.type,
        type: "health_event",
      },
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

    return job ? c.json({ data: job }) : c.body(null, 204);
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

    const job = await claimRecordingJob(jobId, auth.credential.nodeId);

    if (!job) {
      await recordNodeCredentialFailure(c, "recording_jobs.claim.failed", "job_not_claimable", {
        actor: auth.credential,
        target: { id: jobId, type: "recording_job" },
      });
      return c.json({ error: "Recording job is not claimable" }, 409);
    }

    const recording = await recordingStore.find(job.recordingId);

    if (recording) {
      recording.status = "recording";
      await recordingStore.save(recording);
    }

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

  app.get("/api/v1/recording-jobs/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const auth = await authenticateNode(c, "recording_jobs.read_one", {
      id: jobId,
      type: "recording_job",
    });

    if (auth.response) {
      return auth.response;
    }

    const existing = await authorizeJobNode(c, auth.credential, jobId, "recording_jobs.read_one");

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

    const jobId = c.req.header("x-rakkr-recording-job-id");
    const bytes = Buffer.from(await c.req.arrayBuffer());

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

    const before = recordingFileSnapshot(recording);
    const stored = await storeRecordingFile(recording, {
      bytes,
      fileName: c.req.header("x-rakkr-file-name"),
      mimeType: c.req.header("content-type"),
    }).catch(async (error: unknown) => {
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

    recording.cached = true;
    recording.cachePath = stored.cachePath;
    recording.checksum = stored.checksum;
    recording.durationSeconds =
      durationSeconds ?? stored.durationSeconds ?? Math.max(recording.durationSeconds, 1);
    recording.status = "cached";
    recording.waveformPreview = stored.waveformPreview;
    await recordingStore.save(recording);
    const job = await completeRecordingJob(recording.id, jobId);
    const uploadQueueItem = await queueCachedRecordingUpload(c, auth.credential, recording);
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
        size: stored.size,
        uploadQueueItemId: uploadQueueItem?.id,
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

    return c.json({ data: { file: stored, recording: syncedRecording, uploadQueueItem } }, 201);
  });

  async function authenticateNode(
    c: Context<AppBindings>,
    action: string,
    target: AuditTarget,
    permission: NodeServicePermission = "recording:control",
  ): Promise<AuthenticatedNode> {
    const token = bearerToken(c.req.header("authorization"));

    if (!token) {
      await recordNodeCredentialFailure(c, `${action}.failed`, "missing_node_token", {
        permission,
        target,
      });
      return { response: c.json({ error: "Node credential required" }, 401) };
    }

    const credential = await nodeStore.authenticateCredential(token).catch(async () => undefined);

    if (!credential) {
      await recordNodeCredentialFailure(c, `${action}.failed`, "invalid_node_token", {
        permission,
        target,
      });
      return { response: c.json({ error: "Invalid node credential" }, 401) };
    }

    return { credential };
  }

  async function authorizeJobNode(
    c: Context<AppBindings>,
    credential: NodeCredentialAuth,
    jobId: string,
    action: string,
  ) {
    const job = await recordingJob(jobId);

    if (!job) {
      await recordNodeCredentialFailure(c, `${action}.failed`, "job_not_found", {
        actor: credential,
        target: { id: jobId, type: "recording_job" },
      });
      return { response: c.json({ error: "Recording job not found" }, 404) };
    }

    if (job.nodeId !== credential.nodeId) {
      await recordNodeCredentialFailure(c, `${action}.failed`, "node_scope_denied", {
        actor: credential,
        target: { id: job.id, type: "recording_job" },
      });
      return { response: c.json({ error: "Node credential cannot access this job" }, 403) };
    }

    return { job };
  }

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

    const reason = c.req.header("x-rakkr-reason") ?? `agent_${terminalState}`;
    const job =
      terminalState === "cancelled"
        ? await cancelRecordingJob(jobId, reason)
        : await failRecordingJob(jobId, reason);

    if (!job || job.nodeId !== auth.credential.nodeId) {
      return c.json({ error: "Recording job not found" }, 404);
    }

    const recording = await markRecordingJobTerminalRecording(job.recordingId, {
      jobId: job.id,
      reason,
      terminalState,
    });

    await recordJobSuccess(c, `recording_jobs.${terminalState}.succeeded`, auth.credential, job, {
      healthEventId: recording?.healthEventId,
      reason: job.failureReason,
      recordingStatus: recording?.status,
    });

    return c.json({ data: job });
  }

  async function markRecordingJobTerminalRecording(
    recordingId: string,
    input: {
      jobId: string;
      reason: string;
      terminalState: "cancelled" | "failed";
    },
  ) {
    const recording = await recordingStore.find(recordingId);

    if (!recording) {
      return undefined;
    }

    const healthEvent = await createTerminalHealthEvent(recording, input);
    const updated = {
      ...recording,
      status: terminalRecordingStatus(recording, input.terminalState),
    };

    await recordingStore.save(updated);
    await syncRecordingHealth(healthEventStore, recordingStore, recordingId);
    const synced = (await recordingStore.find(recordingId)) ?? updated;

    return {
      ...synced,
      healthEventId: healthEvent?.id,
      terminalState: input.terminalState,
    };
  }

  async function syncAndFindRecording(recording: RecordingSummary) {
    await syncRecordingHealth(healthEventStore, recordingStore, recording.id);

    return (await recordingStore.find(recording.id)) ?? recording;
  }

  async function createTerminalHealthEvent(
    recording: RecordingSummary,
    input: {
      jobId: string;
      reason: string;
      terminalState: "cancelled" | "failed";
    },
  ) {
    if (input.terminalState === "cancelled" && input.reason === "controller_stop_requested") {
      return undefined;
    }

    return healthEventStore.create({
      details: {
        jobId: input.jobId,
        reason: input.reason,
        source: "recording_job_terminal",
        terminalState: input.terminalState,
      },
      nodeId: recording.nodeId,
      recordingId: recording.id,
      scheduleId: recording.scheduleId,
      severity: input.terminalState === "failed" ? "critical" : "warning",
      type: `controller.recording.job_${input.terminalState}`,
    });
  }

  function terminalRecordingStatus(
    recording: RecordingSummary,
    terminalState: "cancelled" | "failed",
  ): RecordingSummary["status"] {
    if (terminalState === "failed") {
      return "failed";
    }

    return recording.status === "cached" || recording.status === "uploaded"
      ? recording.status
      : "completed";
  }

  async function recordJobSuccess(
    c: Context<AppBindings>,
    action: string,
    credential: NodeCredentialAuth,
    job: { id: string; nodeId: string; recordingId: string },
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action,
      actor: nodeActor(credential),
      details: {
        nodeId: job.nodeId,
        recordingId: job.recordingId,
        ...details,
      },
      outcome: "succeeded",
      permission: "recording:control",
      target: {
        id: job.id,
        type: "recording_job",
      },
    });
  }

  async function recordRecordingFileFailure(
    c: Context<AppBindings>,
    input: {
      actor: NodeCredentialAuth;
      createHealthEvent?: boolean;
      jobId?: string;
      reason: string;
      recordingId: string;
      severity?: "critical" | "warning";
      targetName?: string;
    },
  ) {
    const healthEvent = input.createHealthEvent
      ? await healthEventStore.create({
          details: {
            ...(input.jobId ? { jobId: input.jobId } : {}),
            reason: input.reason,
            source: "cache_file_attach",
          },
          nodeId: input.actor.nodeId,
          recordingId: input.recordingId,
          severity: input.severity ?? "warning",
          type: "controller.recording.cache_file_failed",
        })
      : undefined;

    await syncRecordingHealth(healthEventStore, recordingStore, healthEvent?.recordingId);
    await recordAuditEvent(c, {
      action: "recordings.cache_file.attach.failed",
      actor: nodeActor(input.actor),
      details: {
        ...(healthEvent ? { healthEventId: healthEvent.id } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
      },
      outcome: "failed",
      permission: "recording:control",
      reason: input.reason,
      target: {
        id: input.recordingId,
        name: input.targetName,
        type: "recording",
      },
    });
  }

  async function queueCachedRecordingUpload(
    c: Context<AppBindings>,
    actor: NodeCredentialAuth,
    recording: RecordingSummary,
  ) {
    const policy = await uploadPolicyForCachedRecording(recording);

    if (!policy) {
      return undefined;
    }

    try {
      const item = await enqueueRecordingUpload(
        recording,
        uploadQueueInputForPolicy(policy, "policy_on_recording_cached"),
      );

      await recordAuditEvent(c, {
        action: "recordings.upload_queue.auto_enqueue.succeeded",
        actor: nodeActor(actor),
        correlationIds: {
          recordingId: recording.id,
          uploadQueueItemId: item.id,
        },
        details: {
          provider: item.provider,
          target: item.target,
          trigger: policy.trigger,
          uploadPolicyId: policy.id,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return item;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "upload_queue_auto_enqueue_failed";
      const healthEvent = await healthEventStore.create({
        details: {
          reason,
          source: "cache_file_attach",
          uploadPolicyId: policy.id,
        },
        nodeId: actor.nodeId,
        recordingId: recording.id,
        severity: "warning",
        type: "controller.recording.upload_queue_failed",
      });

      await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
      await recordAuditEvent(c, {
        action: "recordings.upload_queue.auto_enqueue.failed",
        actor: nodeActor(actor),
        details: {
          healthEventId: healthEvent.id,
          uploadPolicyId: policy.id,
        },
        outcome: "failed",
        permission: "recording:control",
        reason,
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return undefined;
    }
  }

  async function recordNodeCredentialFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    options: {
      actor?: NodeCredentialAuth;
      permission?: "health:acknowledge" | "node:control" | "recording:control";
      target: AuditTarget;
    },
  ) {
    await recordAuditEvent(c, {
      action,
      actor: options.actor ? nodeActor(options.actor) : undefined,
      outcome:
        reason === "missing_node_token" || reason === "invalid_node_token" ? "denied" : "failed",
      permission: options.permission ?? "recording:control",
      reason,
      target: options.target,
    });
  }
}
