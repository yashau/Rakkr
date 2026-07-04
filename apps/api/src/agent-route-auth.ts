import type { Context } from "hono";
import type { RecordingSummary } from "@rakkr/shared";

import { nodeActor } from "./agent-route-helpers.js";
import { agentJobRecordingScope } from "./agent-job-recording-scope.js";
import { bearerToken } from "./auth-utils.js";
import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import { type NodeCredentialAuth, type NodeStore } from "./node-store.js";
import { recordingJob } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";

export type AuthenticatedNode =
  | { credential: NodeCredentialAuth; response?: never }
  | { credential?: never; response: Response };
export type AuthorizedJobRecording =
  | { recording: RecordingSummary; response?: never }
  | { recording?: never; response: Response };
export type NodeServicePermission = "health:acknowledge" | "node:control" | "recording:control";

export interface AgentRouteAuthDeps {
  healthEventStore: HealthEventStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
}

// Node authentication, job/recording scope authorization, and the audit/health
// failure recorders shared across the agent-facing routes. Extracted from
// agent-routes to keep that module under the LOC guard; closes over the route's
// stores + audit sink, mirroring createAgentCacheUploads.
export function createAgentRouteAuth(deps: AgentRouteAuthDeps) {
  const { healthEventStore, nodeStore, recordAuditEvent, recordingStore } = deps;

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

  async function authorizeJobRecording(
    c: Context<AppBindings>,
    credential: NodeCredentialAuth,
    job: { id: string; recordingId: string },
    action: string,
  ): Promise<AuthorizedJobRecording> {
    const result = await agentJobRecordingScope(job, { credential, recordingStore });

    if (result.ok) {
      return { recording: result.recording };
    }

    await recordNodeCredentialFailure(c, `${action}.failed`, result.reason, {
      actor: credential,
      target: result.target,
    });
    return { response: c.json({ error: result.error }, result.status) };
  }

  async function syncAndFindRecording(recording: RecordingSummary) {
    await syncRecordingHealth(healthEventStore, recordingStore, recording.id);

    return (await recordingStore.find(recording.id)) ?? recording;
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
      target?: AuditTarget;
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
      target: input.target ?? {
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

  return {
    authenticateNode,
    authorizeJobNode,
    authorizeJobRecording,
    recordJobSuccess,
    recordNodeCredentialFailure,
    recordRecordingFileFailure,
    syncAndFindRecording,
  };
}
