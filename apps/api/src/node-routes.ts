import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { buildMeterFrame } from "./demo-data.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { MeterFrameStore } from "./meter-store.js";
import type { NodeStore } from "./node-store.js";
import { NodeStoreError } from "./node-store.js";

interface NodeRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  meterFrameStore: MeterFrameStore;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
}

const nodeInterfaceSchema = z.object({
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
    .default([]),
  sampleRates: z.array(z.coerce.number().int().positive()).max(16).default([]),
  systemName: z.string().trim().min(1).max(255),
  systemRef: z.string().trim().min(1).max(255).optional(),
});
const nodeEnrollmentSchema = z
  .object({
    agentVersion: z.string().trim().min(1).max(80).default("unknown"),
    alias: z.string().trim().min(1).max(160),
    hostname: z.string().trim().min(1).max(255),
    interfaces: z.array(nodeInterfaceSchema).max(32).default([]),
    ipAddresses: z.array(z.string().trim().min(1).max(120)).max(16).default([]),
    location: z.object({
      building: z.string().trim().min(1).max(120).optional(),
      floor: z.string().trim().min(1).max(80).optional(),
      room: z.string().trim().min(1).max(160),
      site: z.string().trim().min(1).max(160),
    }),
    notes: z.string().trim().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(32).default([]),
  })
  .strict();

export function registerNodeRoutes({
  app,
  currentAuth,
  currentUser,
  hasResourceScope,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
}: NodeRouteDependencies) {
  app.get("/api/v1/nodes", requirePermission("node:read", "nodes.read"), async (c) =>
    c.json({ data: await scopedNodes(currentUser(c)) }),
  );

  app.post(
    "/api/v1/nodes/enroll",
    requirePermission("node:manage", "nodes.enroll", () => ({ type: "node" })),
    async (c) => {
      const body = nodeEnrollmentSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordNodeFailure(c, "nodes.enroll.failed", "invalid_request");
        return c.json({ error: "Invalid node enrollment", issues: body.error.issues }, 400);
      }

      try {
        const result = await nodeStore.enroll(body.data, currentUser(c).id);

        await recordAuditEvent(c, {
          action: "nodes.enroll.succeeded",
          after: nodeSnapshot(result.node),
          auth: currentAuth(c),
          details: credentialDetails(result.credential),
          outcome: "succeeded",
          permission: "node:manage",
          target: {
            id: result.node.id,
            name: result.node.alias,
            type: "node",
          },
        });

        return c.json({ data: result }, 201);
      } catch (error) {
        const reason = error instanceof NodeStoreError ? error.code : "node_enrollment_failed";

        await recordNodeFailure(c, "nodes.enroll.failed", reason, body.data.alias);
        return c.json({ error: "Node enrollment unavailable" }, 503);
      }
    },
  );

  app.post(
    "/api/v1/nodes/:nodeId/credentials/rotate",
    requirePermission("node:manage", "nodes.credentials.rotate", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const before = await nodeStore.find(nodeId);
      const result = await nodeStore
        .rotateCredential(nodeId, currentUser(c).id)
        .catch(async (error: unknown) => {
          const reason =
            error instanceof NodeStoreError ? error.code : "credential_rotation_failed";

          await recordNodeFailure(c, "nodes.credentials.rotate.failed", reason, nodeId);
          return "unavailable" as const;
        });

      if (result === "unavailable") {
        return c.json({ error: "Node credential rotation unavailable" }, 503);
      }

      if (!result) {
        await recordNodeFailure(c, "nodes.credentials.rotate.failed", "node_not_found", nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "nodes.credentials.rotate.succeeded",
        after: nodeSnapshot(result.node),
        auth: currentAuth(c),
        before: nodeSnapshot(before),
        details: credentialDetails(result.credential),
        outcome: "succeeded",
        permission: "node:manage",
        target: {
          id: result.node.id,
          name: result.node.alias,
          type: "node",
        },
      });

      return c.json({ data: result }, 201);
    },
  );

  app.get(
    "/api/v1/nodes/:nodeId/meters",
    requirePermission("node:read", "meters.read", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const frame = (await meterFrameStore.latest(nodeId)) ?? buildMeterFrame();

      if (!(await nodeStore.find(nodeId))) {
        return c.json({ error: "Node not found" }, 404);
      }

      if (nodeId !== frame.nodeId) {
        return c.json({ error: "Meter data unavailable" }, 409);
      }

      return c.json({ data: frame });
    },
  );

  app.post(
    "/api/v1/nodes/:nodeId/listen",
    requirePermission("listen:monitor", "listen.monitor.start", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const node = await nodeStore.find(c.req.param("nodeId"));

      if (!node) {
        await recordNodeFailure(c, "listen.monitor.start.failed", "node_not_found", undefined, {
          permission: "listen:monitor",
        });
        return c.json({ error: "Node not found" }, 404);
      }

      const sessionId = `listen_${randomUUID()}`;

      await recordAuditEvent(c, {
        action: "listen.monitor.start.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          listenSessionId: sessionId,
        },
        details: {
          mode: "stubbed",
          targetLatencyMs: 1500,
        },
        outcome: "succeeded",
        permission: "listen:monitor",
        target: {
          id: node.id,
          name: node.alias,
          type: "node",
        },
      });

      return c.json(
        {
          data: {
            mode: "stubbed",
            nodeId: node.id,
            sessionId,
            startedAt: new Date().toISOString(),
            targetLatencyMs: 1500,
          },
        },
        202,
      );
    },
  );

  app.get("/api/v1/meter-events", requirePermission("node:read", "meters.stream"), (c) => {
    const user = currentUser(c);

    return streamSSE(c, async (stream) => {
      while (true) {
        const frame = await liveMeterFrame();

        if (await hasResourceScope(user, { id: frame.nodeId, type: "node" })) {
          await stream.writeSSE({
            data: JSON.stringify(frame),
            event: "meter",
          });
        }

        await stream.sleep(1000);
      }
    });
  });

  async function liveMeterFrame() {
    const seededFrame = buildMeterFrame();

    return (await meterFrameStore.latest(seededFrame.nodeId)) ?? seededFrame;
  }

  async function recordNodeFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    name?: string,
    options: {
      permission?: "listen:monitor" | "node:manage";
    } = {},
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: options.permission ?? "node:manage",
      reason,
      target: {
        name,
        type: "node",
      },
    });
  }
}

function nodeSnapshot(node: RecorderNode | undefined) {
  return node
    ? {
        agentVersion: node.agentVersion,
        alias: node.alias,
        hostname: node.hostname,
        interfaces: node.interfaces.length,
        ipAddresses: node.ipAddresses,
        location: node.location,
        status: node.status,
        tags: node.tags,
      }
    : undefined;
}

function credentialDetails(credential: { id: string; tokenPrefix: string }) {
  return {
    credentialId: credential.id,
    tokenPrefix: credential.tokenPrefix,
  };
}
