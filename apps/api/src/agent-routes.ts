import type { Context, Hono } from "hono";
import { healthSeveritySchema, meterFrameSchema, type RecordingSummary } from "@rakkr/shared";
import { z } from "zod";

import { bearerToken } from "./auth-utils.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { MeterFrameStore } from "./meter-store.js";
import type { NodeCredentialAuth, NodeStore } from "./node-store.js";
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

interface AgentRouteDependencies {
  app: Hono<AppBindings>;
  healthEventStore: HealthEventStore;
  meterFrameStore: MeterFrameStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
}

type AuthenticatedNode =
  | { credential: NodeCredentialAuth; response?: never }
  | { credential?: never; response: Response };

export function registerAgentRoutes({
  app,
  healthEventStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  recordingStore,
}: AgentRouteDependencies) {
  app.post("/api/v1/nodes/:nodeId/meter-frame", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNode(c, "nodes.meter_frame.ingest", {
      id: nodeId,
      type: "node",
    });

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
    const auth = await authenticateNode(c, "nodes.health_events.sync", {
      id: nodeId,
      type: "node",
    });

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

    const bytes = Buffer.from(await c.req.arrayBuffer());

    if (bytes.byteLength === 0) {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        reason: "empty_file",
        recordingId,
        targetName: recording.name,
      });
      return c.json({ error: "Recording cache file cannot be empty" }, 400);
    }

    const durationSeconds = durationFromHeader(c.req.header("x-rakkr-duration-seconds"));

    if (durationSeconds === "invalid") {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
        reason: "invalid_duration",
        recordingId,
        targetName: recording.name,
      });
      return c.json({ error: "Invalid x-rakkr-duration-seconds header" }, 400);
    }

    const before = recordingFileSnapshot(recording);
    const jobId = c.req.header("x-rakkr-recording-job-id");
    const stored = await storeRecordingFile(recording, {
      bytes,
      fileName: c.req.header("x-rakkr-file-name"),
      mimeType: c.req.header("content-type"),
    }).catch(async (error: unknown) => {
      await recordRecordingFileFailure(c, {
        actor: auth.credential,
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
    await recordingStore.save(recording);
    const job = await completeRecordingJob(recording.id, jobId);

    await recordAuditEvent(c, {
      action: "recordings.cache_file.attach.succeeded",
      actor: nodeActor(auth.credential),
      after: recordingFileSnapshot(recording),
      before,
      details: {
        cachePath: stored.cachePath,
        fileName: stored.fileName,
        jobId,
        jobStatus: job?.status,
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
  });

  async function authenticateNode(
    c: Context<AppBindings>,
    action: string,
    target: AuditTarget,
  ): Promise<AuthenticatedNode> {
    const token = bearerToken(c.req.header("authorization"));

    if (!token) {
      await recordNodeCredentialFailure(c, `${action}.failed`, "missing_node_token", { target });
      return { response: c.json({ error: "Node credential required" }, 401) };
    }

    const credential = await nodeStore.authenticateCredential(token).catch(async () => undefined);

    if (!credential) {
      await recordNodeCredentialFailure(c, `${action}.failed`, "invalid_node_token", { target });
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

    await recordJobSuccess(c, `recording_jobs.${terminalState}.succeeded`, auth.credential, job, {
      reason: job.failureReason,
    });

    return c.json({ data: job });
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
      reason: string;
      recordingId: string;
      targetName?: string;
    },
  ) {
    await recordAuditEvent(c, {
      action: "recordings.cache_file.attach.failed",
      actor: nodeActor(input.actor),
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

const nodeHealthEventSchema = z
  .object({
    details: z.record(z.string(), z.unknown()).default({}),
    id: z.string().trim().min(1).max(160).optional(),
    openedAt: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !Number.isNaN(Date.parse(value)), "Expected ISO date/time")
      .optional(),
    recordingId: z.string().trim().min(1).max(160).optional(),
    scheduleId: z.string().trim().min(1).max(160).optional(),
    severity: healthSeveritySchema,
    type: z.string().trim().min(1).max(160),
  })
  .strict();

function nodeActor(credential: NodeCredentialAuth) {
  return {
    id: credential.nodeId,
    name: credential.nodeId,
    roles: [],
    type: "node" as const,
  };
}

function nodeHealthEventDetails(input: z.infer<typeof nodeHealthEventSchema>) {
  return {
    ...input.details,
    localEventId: input.id,
  };
}

function recordingFileSnapshot(recording: RecordingSummary) {
  return {
    cachePath: recording.cachePath,
    cached: recording.cached,
    durationSeconds: recording.durationSeconds,
    status: recording.status,
  };
}

function durationFromHeader(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const duration = Number(value);

  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : "invalid";
}
