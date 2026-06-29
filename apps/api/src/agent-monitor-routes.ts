import type { Context, Hono } from "hono";
import { z } from "zod";

import { nodeActor } from "./agent-route-helpers.js";
import { bearerToken } from "./auth-utils.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { ListenMonitorStore } from "./listen-monitor-store.js";
import type { NodeCredentialAuth, NodeStore } from "./node-store.js";

interface AgentMonitorRouteDependencies {
  app: Hono<AppBindings>;
  listenMonitorStore: ListenMonitorStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
}

const monitorHeaderSchema = z.object({
  capturedAt: z.string().datetime(),
  contentType: z.literal("audio/wav"),
  durationMs: z.coerce.number().int().min(1).max(10_000),
});

export function registerAgentMonitorRoutes({
  app,
  listenMonitorStore,
  nodeStore,
  recordAuditEvent,
}: AgentMonitorRouteDependencies) {
  app.post("/api/v1/nodes/:nodeId/listen/chunk", async (c) => {
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

    const headers = monitorHeaderSchema.safeParse({
      capturedAt: c.req.header("x-rakkr-captured-at") ?? new Date().toISOString(),
      contentType: contentType(c.req.header("content-type")),
      durationMs: c.req.header("x-rakkr-duration-ms"),
    });

    if (!headers.success) {
      await recordFailure(c, recordAuditEvent, "invalid_request", {
        actor: auth.credential,
        target,
      });
      return c.json({ error: "Invalid monitor chunk headers", issues: headers.error.issues }, 400);
    }

    const audio = new Uint8Array(await c.req.arrayBuffer());

    if (audio.byteLength < 44 || audio.byteLength > 524_288) {
      await recordFailure(c, recordAuditEvent, "invalid_request", {
        actor: auth.credential,
        target,
      });
      return c.json({ error: "Invalid monitor chunk size" }, 400);
    }

    const rendition = c.req.query("rendition") === "enhanced" ? "enhanced" : "raw";
    const stored = await listenMonitorStore.save({
      audio,
      capturedAt: headers.data.capturedAt,
      contentType: headers.data.contentType,
      durationMs: headers.data.durationMs,
      nodeId,
      rendition,
    });

    await recordAuditEvent(c, {
      action: "nodes.listen_monitor.chunk.ingest.succeeded",
      actor: nodeActor(auth.credential),
      details: {
        capturedAt: stored.capturedAt,
        durationMs: stored.durationMs,
        receivedAt: stored.receivedAt,
        rendition: stored.rendition,
        sizeBytes: audio.byteLength,
        source: stored.source,
      },
      outcome: "succeeded",
      permission: "node:control",
      target: { id: nodeId, type: "node" },
    });

    return c.json(
      {
        data: {
          capturedAt: stored.capturedAt,
          durationMs: stored.durationMs,
          nodeId: stored.nodeId,
          receivedAt: stored.receivedAt,
          source: stored.source,
        },
      },
      202,
    );
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
    action: "nodes.listen_monitor.chunk.ingest.failed",
    actor: options.actor ? nodeActor(options.actor) : undefined,
    outcome:
      reason === "missing_node_token" || reason === "invalid_node_token" ? "denied" : "failed",
    permission: "node:control",
    reason,
    target: options.target,
  });
}

function contentType(value: string | undefined) {
  return value?.split(";").at(0)?.trim().toLowerCase();
}
