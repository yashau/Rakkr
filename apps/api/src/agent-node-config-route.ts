import type { Context, Hono } from "hono";
import { defaultNodeRecordingCapacity, type RetentionPolicy } from "@rakkr/shared";

import { nodeActor } from "./agent-route-helpers.js";
import { bearerToken } from "./auth-utils.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { NodeCredentialAuth, NodeStore } from "./node-store.js";
import { listRetentionPolicies } from "./retention-policies.js";

interface AgentNodeConfigRouteDependencies {
  app: Hono<AppBindings>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
}

export function registerAgentNodeConfigRoute({
  app,
  nodeStore,
  recordAuditEvent,
}: AgentNodeConfigRouteDependencies) {
  app.get("/api/v1/nodes/:nodeId/config", async (c) => {
    const nodeId = c.req.param("nodeId");
    const auth = await authenticateNodeConfig(c, nodeStore, recordAuditEvent, nodeId);

    if (auth.response) {
      return auth.response;
    }

    if (auth.credential.nodeId !== nodeId) {
      await recordNodeConfigFailure(c, recordAuditEvent, "node_scope_denied", {
        actor: auth.credential,
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node credential cannot access this node" }, 403);
    }

    const node = await nodeStore.find(nodeId);

    if (!node) {
      await recordNodeConfigFailure(c, recordAuditEvent, "node_not_found", {
        actor: auth.credential,
        target: { id: nodeId, type: "node" },
      });
      return c.json({ error: "Node not found" }, 404);
    }

    const recordingCapacity = node.recordingCapacity ?? defaultNodeRecordingCapacity;
    const recorderCachePolicies = (await listRetentionPolicies())
      .filter(isExecutableRecorderCachePolicy)
      .map(recorderCachePolicyConfig);

    await recordAuditEvent(c, {
      action: "nodes.config.read.succeeded",
      actor: nodeActor(auth.credential),
      details: { recorderCachePolicyCount: recorderCachePolicies.length, recordingCapacity },
      outcome: "succeeded",
      permission: "node:control",
      target: {
        id: nodeId,
        type: "node",
      },
    });

    return c.json({ data: { recorderCachePolicies, recordingCapacity } });
  });
}

async function authenticateNodeConfig(
  c: Context<AppBindings>,
  nodeStore: NodeStore,
  recordAuditEvent: RecordAuditEvent,
  nodeId: string,
) {
  const token = bearerToken(c.req.header("authorization"));
  const target = { id: nodeId, type: "node" } satisfies AuditTarget;

  if (!token) {
    await recordNodeConfigFailure(c, recordAuditEvent, "missing_node_token", { target });
    return { response: c.json({ error: "Node credential required" }, 401) };
  }

  const credential = await nodeStore.authenticateCredential(token).catch(async () => undefined);

  if (!credential) {
    await recordNodeConfigFailure(c, recordAuditEvent, "invalid_node_token", { target });
    return { response: c.json({ error: "Invalid node credential" }, 401) };
  }

  return { credential };
}

async function recordNodeConfigFailure(
  c: Context<AppBindings>,
  recordAuditEvent: RecordAuditEvent,
  reason: string,
  options: {
    actor?: NodeCredentialAuth;
    target: AuditTarget;
  },
) {
  await recordAuditEvent(c, {
    action: "nodes.config.read.failed",
    actor: options.actor ? nodeActor(options.actor) : undefined,
    outcome:
      reason === "missing_node_token" || reason === "invalid_node_token" ? "denied" : "failed",
    permission: "node:control",
    reason,
    target: options.target,
  });
}

function isExecutableRecorderCachePolicy(policy: RetentionPolicy) {
  return policy.enabled && policy.scope === "recorder_cache" && policy.action === "delete_cache";
}

function recorderCachePolicyConfig(policy: RetentionPolicy) {
  return {
    deleteAfterUpload:
      policy.maxAgeDays === null && policy.maxBytes === null && policy.minFreeDiskPercent === null,
    maxAgeDays: policy.maxAgeDays,
    maxBytes: policy.maxBytes,
    minFreeDiskPercent: policy.minFreeDiskPercent,
    policyId: policy.id,
  };
}
