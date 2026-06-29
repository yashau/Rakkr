import type { Context, Hono } from "hono";

import { assignedChannelMaps, nodeActor } from "./agent-route-helpers.js";
import { bearerToken } from "./auth-utils.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { NodeCredentialAuth, NodeStore } from "./node-store.js";
import type { SettingsStore } from "./settings-store.js";

interface AgentChannelMapRouteDependencies {
  app: Hono<AppBindings>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  settingsStore: SettingsStore;
}

export function registerAgentChannelMapRoute({
  app,
  nodeStore,
  recordAuditEvent,
  settingsStore,
}: AgentChannelMapRouteDependencies) {
  app.get("/api/v1/nodes/:nodeId/channel-map-assignments", async (c) => {
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

    const node = await nodeStore.find(nodeId);

    if (!node) {
      await recordFailure(c, recordAuditEvent, "node_not_found", {
        actor: auth.credential,
        target,
      });
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
      target,
    });

    return c.json({ data: assignments });
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
    action: "nodes.channel_map_assignments.read.failed",
    actor: options.actor ? nodeActor(options.actor) : undefined,
    outcome:
      reason === "missing_node_token" || reason === "invalid_node_token" ? "denied" : "failed",
    permission: "node:control",
    reason,
    target: options.target,
  });
}
