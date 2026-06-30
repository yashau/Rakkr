import type { Context, Hono } from "hono";

import { nodeActor } from "./agent-route-helpers.js";
import { bearerToken } from "./auth-utils.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { NodeCredentialAuth, NodeStore } from "./node-store.js";
import { claimNextRecordingGroup } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";

interface AgentClaimGroupRouteDependencies {
  app: Hono<AppBindings>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
}

export function registerAgentClaimGroupRoute({
  app,
  nodeStore,
  recordAuditEvent,
  recordingStore,
}: AgentClaimGroupRouteDependencies) {
  app.post("/api/v1/nodes/:nodeId/recording-jobs/claim-next-group", async (c) => {
    const nodeId = c.req.param("nodeId");
    const target = { id: nodeId, type: "node" as const };
    const auth = await authenticateNode(c, nodeStore, recordAuditEvent, target);

    if (auth.response) {
      return auth.response;
    }

    if (auth.credential.nodeId !== nodeId) {
      await recordFailure(c, recordAuditEvent, "node_scope_denied", {
        actor: auth.credential,
        target,
      });
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    // Claims the next queued job and every queued sibling sharing its capture
    // group, so the agent captures the shared device once and renders each
    // job's channel subset from that single capture.
    const claimed = await claimNextRecordingGroup(nodeId, auth.credential.nodeId);

    if (claimed.length === 0) {
      await recordAuditEvent(c, {
        action: "recording_jobs.claim_next_group.succeeded",
        actor: nodeActor(auth.credential),
        details: { claimed: false },
        outcome: "succeeded",
        permission: "recording:control",
        target,
      });
      return c.body(null, 204);
    }

    for (const job of claimed) {
      const recording = await recordingStore.find(job.recordingId);

      if (recording) {
        recording.status = "recording";
        await recordingStore.save(recording);
      }

      await recordAuditEvent(c, {
        action: "recording_jobs.claim_next_group.succeeded",
        actor: nodeActor(auth.credential),
        details: { nodeId: job.nodeId, recordingId: job.recordingId },
        outcome: "succeeded",
        permission: "recording:control",
        target: { id: job.id, type: "recording_job" },
      });
    }

    return c.json({ data: claimed });
  });
}

async function authenticateNode(
  c: Context<AppBindings>,
  nodeStore: NodeStore,
  recordAuditEvent: RecordAuditEvent,
  target: AuditTarget,
) {
  const token = bearerToken(c.req.header("authorization"));

  if (!token) {
    await recordFailure(c, recordAuditEvent, "missing_node_token", { target });
    return { response: c.json({ error: "Node credential required" }, 401) };
  }

  const credential = await nodeStore.authenticateCredential(token).catch(async () => undefined);

  if (!credential) {
    await recordFailure(c, recordAuditEvent, "invalid_node_token", { target });
    return { response: c.json({ error: "Invalid node credential" }, 401) };
  }

  return { credential };
}

async function recordFailure(
  c: Context<AppBindings>,
  recordAuditEvent: RecordAuditEvent,
  reason: string,
  options: { actor?: NodeCredentialAuth; target: AuditTarget },
) {
  await recordAuditEvent(c, {
    action: "recording_jobs.claim_next_group.failed",
    actor: options.actor ? nodeActor(options.actor) : undefined,
    outcome:
      reason === "missing_node_token" || reason === "invalid_node_token" ? "denied" : "failed",
    permission: "recording:control",
    reason,
    target: options.target,
  });
}
