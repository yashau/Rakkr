import type { Context, Hono } from "hono";
import { meterFrameSchema } from "@rakkr/shared";

import { nodeActor } from "./agent-route-helpers.js";
import { bearerToken } from "./auth-utils.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { MeterFrameStore } from "./meter-store.js";
import type { NodeCredentialAuth, NodeStore } from "./node-store.js";

interface AgentMeterFrameRouteDependencies {
  app: Hono<AppBindings>;
  meterFrameStore: MeterFrameStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
}

export function registerAgentMeterFrameRoute({
  app,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
}: AgentMeterFrameRouteDependencies) {
  app.post("/api/v1/nodes/:nodeId/meter-frame", async (c) => {
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

    const body = meterFrameSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordFailure(c, recordAuditEvent, "invalid_request", {
        actor: auth.credential,
        target,
      });
      return c.json({ error: "Invalid meter frame", issues: body.error.issues }, 400);
    }

    if (body.data.nodeId !== nodeId || body.data.nodeId !== auth.credential.nodeId) {
      await recordFailure(c, recordAuditEvent, "node_scope_denied", {
        actor: auth.credential,
        target: { id: body.data.nodeId, type: "node" },
      });
      return c.json({ error: "Meter frame node mismatch" }, 403);
    }

    const stored = await meterFrameStore.save(body.data);

    await recordAuditEvent(c, {
      action: "nodes.meter_frame.ingest.succeeded",
      actor: nodeActor(auth.credential),
      details: {
        capturedAt: stored.frame.capturedAt,
        clippingCount: stored.frame.levels.filter((level) => level.clipping).length,
        interfaceId: stored.frame.interfaceId,
        levelCount: stored.frame.levels.length,
        qualityLevelCount: stored.frame.levels.filter((level) => level.quality).length,
        receivedAt: stored.receivedAt,
      },
      outcome: "succeeded",
      permission: "node:control",
      target,
    });

    return c.json({ data: stored }, 202);
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
    action: "nodes.meter_frame.ingest.failed",
    actor: options.actor ? nodeActor(options.actor) : undefined,
    outcome:
      reason === "missing_node_token" || reason === "invalid_node_token" ? "denied" : "failed",
    permission: "node:control",
    reason,
    target: options.target,
  });
}
