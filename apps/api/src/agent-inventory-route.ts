import type { Context, Hono } from "hono";
import { z } from "zod";

import { nodeActor } from "./agent-route-helpers.js";
import { bearerToken } from "./auth-utils.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import { reconcileSummaryChanged } from "./node-inventory-reconcile.js";
import { NodeStoreError, type NodeCredentialAuth, type NodeStore } from "./node-store.js";

interface AgentInventoryRouteDependencies {
  app: Hono<AppBindings>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
}

// The agent owns hardware truth, so it reports its discovered interfaces on
// startup. The controller reconciles them into `node.interfaces` (preserving
// operator labels + channel-map assignments). Authenticated with the node
// credential and gated like the heartbeat (`node:control`).
const agentInterfaceSchema = z.object({
  alias: z.string().trim().min(1).max(160),
  backend: z.enum(["alsa", "jack", "pipewire", "unknown"]).default("unknown"),
  channelCount: z.coerce.number().int().min(0).max(256),
  channels: z
    .array(
      z.object({
        alias: z.string().trim().min(1).max(160),
        index: z.coerce.number().int().positive().max(256),
      }),
    )
    .max(256)
    .default([]),
  hardwarePath: z.string().trim().min(1).max(500).optional(),
  sampleRates: z.array(z.coerce.number().int().positive()).max(16).default([]),
  serialNumber: z.string().trim().min(1).max(255).optional(),
  systemName: z.string().trim().min(1).max(255),
  systemRef: z.string().trim().min(1).max(255).optional(),
});
const agentInventorySchema = z
  .object({
    interfaces: z.array(agentInterfaceSchema).max(64).default([]),
  })
  .passthrough();

export function registerAgentInventoryRoute({
  app,
  nodeStore,
  recordAuditEvent,
}: AgentInventoryRouteDependencies) {
  app.post("/api/v1/nodes/:nodeId/inventory", async (c) => {
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

    const body = agentInventorySchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordFailure(c, recordAuditEvent, "invalid_request", {
        actor: auth.credential,
        target,
      });
      return c.json({ error: "Invalid node inventory", issues: body.error.issues }, 400);
    }

    const result = await nodeStore
      .reconcileInterfaces(nodeId, body.data.interfaces)
      .catch(async (error: unknown) => {
        const reason = error instanceof NodeStoreError ? error.code : "inventory_reconcile_failed";

        await recordFailure(c, recordAuditEvent, reason, { actor: auth.credential, target });
        return "unavailable" as const;
      });

    if (result === "unavailable") {
      return c.json({ error: "Node inventory reconcile unavailable" }, 503);
    }

    if (!result) {
      await recordFailure(c, recordAuditEvent, "node_not_found", {
        actor: auth.credential,
        target,
      });
      return c.json({ error: "Node not found" }, 404);
    }

    const { node, summary } = result;
    const changed = reconcileSummaryChanged(summary);

    // Idempotent: only a real change is auditable; an unchanged report is a no-op.
    if (changed) {
      await recordAuditEvent(c, {
        action: "nodes.inventory.reconciled",
        actor: nodeActor(auth.credential),
        after: {
          absent: summary.absent,
          added: summary.added,
          interfaceCount: node.interfaces.length,
          reactivated: summary.reactivated,
          updated: summary.updated,
        },
        details: {
          absentCount: summary.absent.length,
          addedCount: summary.added.length,
          reactivatedCount: summary.reactivated.length,
          reportedCount: body.data.interfaces.length,
          unchangedCount: summary.unchanged,
          updatedCount: summary.updated.length,
        },
        outcome: "succeeded",
        permission: "node:control",
        target: { id: node.id, name: node.alias, type: "node" },
      });
    }

    return c.json({ data: { changed, node, summary } }, 202);
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
    action: "nodes.inventory.reconciled.failed",
    actor: options.actor ? nodeActor(options.actor) : undefined,
    outcome:
      reason === "missing_node_token" || reason === "invalid_node_token" ? "denied" : "failed",
    permission: "node:control",
    reason,
    target: options.target,
  });
}
