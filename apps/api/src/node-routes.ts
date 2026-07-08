import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  defaultNodeRecordingCapacity,
  nodeAudioCommandDefaultsSchema,
  nodeRecordingCapacitySchema,
  nodeRuntimeSchema,
  type MeterFrame,
  type RecorderNode,
} from "@rakkr/shared";

import { registerAgentReleaseRoutes } from "./agent-release-routes.js";
import type { AgentReleaseService } from "./agent-release-service.js";
import type { AuthResult } from "./auth-service.js";
import { buildMeterFrame, demoMetersEnabled } from "./demo-data.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { ListenMonitorStore } from "./listen-monitor-store.js";
import type { ListenSessionStore } from "./listen-session-store.js";
import { resolveVisibleMeterFrame } from "./meter-room-access.js";
import type { MeterFrameStore } from "./meter-store.js";
import { registerNodeActionRoutes } from "./node-action-routes.js";
import { registerNodeInventoryRoutes } from "./node-inventory-routes.js";
import { nodeLifecycleService, type NodeLifecycleService } from "./node-lifecycle.js";
import { registerNodeBootstrapRoutes } from "./node-bootstrap-routes.js";
import type { NodeBootstrapStore } from "./node-bootstrap-store.js";
import { registerNodeLifecycleRoutes } from "./node-lifecycle-routes.js";
import { registerNodeListenRoutes } from "./node-listen-routes.js";
import { registerNodeSshCredentialRoutes } from "./node-ssh-credential-routes.js";
import type { NodeSshCredentialStore } from "./node-ssh-credential-store.js";
import type { NodeStore } from "./node-store.js";
import { NodeStoreError } from "./node-store.js";

interface NodeRouteDependencies {
  agentReleaseService?: AgentReleaseService;
  app: Hono<AppBindings>;
  bootstrapStore: NodeBootstrapStore;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  // Whether the caller may receive the whole-node live monitor audio. The monitor
  // chunk is a single pre-mixed WAV that cannot be filtered per-channel like a
  // meter frame, so a shared-node partial owner must be refused. Defaults to
  // allow (single-room/full-authority behavior) for tests.
  canServeWholeNodeMonitor?: (
    user: NonNullable<AuthResult["user"]>,
    node: RecorderNode,
  ) => Promise<boolean>;
  // Strict per-channel meter filtering: drops levels for channels the caller's
  // rooms do not own. Defaults to identity (no filtering) for tests.
  filterMeterFrame?: (
    user: NonNullable<AuthResult["user"]>,
    node: RecorderNode,
    frame: MeterFrame,
  ) => Promise<MeterFrame>;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  listenMonitorStore: ListenMonitorStore;
  listenSessionStore: ListenSessionStore;
  meterFrameStore: MeterFrameStore;
  nodeLifecycleService?: NodeLifecycleService;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  sshCredentialStore: NodeSshCredentialStore;
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
  hardwarePath: z.string().trim().min(1).max(500).optional(),
  sampleRates: z.array(z.coerce.number().int().positive()).max(16).default([]),
  serialNumber: z.string().trim().min(1).max(255).optional(),
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
    audioDefaults: nodeAudioCommandDefaultsSchema.optional(),
    recordingCapacity: nodeRecordingCapacitySchema.optional(),
    runtime: nodeRuntimeSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(32).default([]),
  })
  .strict();
const nodeUpdateSchema = z
  .object({
    alias: z.string().trim().min(1).max(160).optional(),
    hostname: z.string().trim().min(1).max(255).optional(),
    ipAddresses: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
    location: z
      .object({
        building: z.string().trim().min(1).max(120).nullable().optional(),
        floor: z.string().trim().min(1).max(80).nullable().optional(),
        room: z.string().trim().min(1).max(160).optional(),
        site: z.string().trim().min(1).max(160).optional(),
      })
      .strict()
      .optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    audioDefaults: nodeAudioCommandDefaultsSchema.optional(),
    recordingCapacity: nodeRecordingCapacitySchema.optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(32).optional(),
  })
  .strict()
  .refine(hasNodeUpdate, "At least one node field is required");
const nodeInterfaceUpdateSchema = z
  .object({
    alias: z.string().trim().min(1).max(160).optional(),
    channels: z
      .array(
        z.object({
          alias: z.string().trim().min(1).max(160),
          index: z.coerce.number().int().positive().max(256),
        }),
      )
      .max(256)
      .optional(),
    hardwarePath: z.string().trim().min(1).max(500).nullable().optional(),
    sampleRates: z.array(z.coerce.number().int().positive()).max(16).optional(),
    serialNumber: z.string().trim().min(1).max(255).nullable().optional(),
    systemName: z.string().trim().min(1).max(255).optional(),
    systemRef: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine(hasNodeUpdate, "At least one interface field is required");

export function registerNodeRoutes({
  agentReleaseService: releaseService,
  app,
  bootstrapStore,
  canServeWholeNodeMonitor = async () => true,
  currentAuth,
  currentUser,
  filterMeterFrame = async (_user, _node, frame) => frame,
  listenMonitorStore,
  listenSessionStore,
  meterFrameStore,
  nodeLifecycleService: lifecycleService = nodeLifecycleService(),
  nodeStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
  sshCredentialStore,
}: NodeRouteDependencies) {
  // Register the static `/api/v1/nodes/agent-release` route BEFORE any
  // `/api/v1/nodes/:nodeId` route. The node route set mixes a static child
  // (`/export`) with a param child (`:nodeId`) at the same trie position, which
  // Hono's RegExpRouter cannot represent, so the whole app falls back to the
  // registration-order-sensitive TrieRouter. A static route registered AFTER
  // `:nodeId` loses the match and gets swallowed by the detail handler (→ 404).
  // Keeping this first mirrors how `/export` avoids the collision.
  registerAgentReleaseRoutes({
    agentReleaseService: releaseService,
    app,
    requirePermission,
  });
  registerNodeInventoryRoutes({
    app,
    currentAuth,
    currentUser,
    recordAuditEvent,
    requirePermission,
    scopedNodes,
  });
  registerNodeActionRoutes({
    app,
    currentUser,
    listenMonitorStore,
    meterFrameStore,
    recordAuditEvent,
    requirePermission,
    scopedNodes,
  });
  registerNodeLifecycleRoutes({
    app,
    currentAuth,
    currentUser,
    nodeLifecycleService: lifecycleService,
    recordAuditEvent,
    requirePermission,
    scopedNodes,
  });
  registerNodeSshCredentialRoutes({
    app,
    currentAuth,
    currentUser,
    nodeStore,
    recordAuditEvent,
    requirePermission,
    scopedNodes,
    sshCredentialStore,
  });
  registerNodeBootstrapRoutes({
    app,
    bootstrapStore,
    currentAuth,
    currentUser,
    nodeStore,
    recordAuditEvent,
    requirePermission,
    scopedNodes,
    sshCredentialStore,
  });
  registerNodeListenRoutes({
    app,
    canServeWholeNodeMonitor,
    currentAuth,
    currentUser,
    listenMonitorStore,
    listenSessionStore,
    meterFrameStore,
    recordAuditEvent,
    requirePermission,
    scopedNodes,
  });

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

  app.patch(
    "/api/v1/nodes/:nodeId",
    requirePermission("node:manage", "nodes.update", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const body = nodeUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordNodeFailure(c, "nodes.update.failed", "invalid_request", nodeId, {
          targetId: nodeId,
        });
        return c.json({ error: "Invalid node update", issues: body.error.issues }, 400);
      }

      const before = await findScopedNode(c, nodeId);

      if (!before) {
        await recordNodeFailure(c, "nodes.update.failed", "node_not_found", nodeId, {
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      const updated = await nodeStore.update(nodeId, body.data).catch(async (error: unknown) => {
        const reason = error instanceof NodeStoreError ? error.code : "node_update_failed";

        await recordNodeFailure(c, "nodes.update.failed", reason, before.alias, {
          targetId: nodeId,
        });
        return "unavailable" as const;
      });

      if (updated === "unavailable") {
        return c.json({ error: "Node update unavailable" }, 503);
      }

      if (!updated) {
        await recordNodeFailure(c, "nodes.update.failed", "node_not_found", before.alias, {
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "nodes.update.succeeded",
        after: nodeSnapshot(updated),
        auth: currentAuth(c),
        before: nodeSnapshot(before),
        outcome: "succeeded",
        permission: "node:manage",
        target: {
          id: updated.id,
          name: updated.alias,
          type: "node",
        },
      });

      return c.json({ data: updated });
    },
  );

  app.patch(
    "/api/v1/nodes/:nodeId/interfaces/:interfaceId",
    requirePermission("node:manage", "nodes.interfaces.update", (c) => ({
      id: c.req.param("interfaceId"),
      type: "interface",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const interfaceId = c.req.param("interfaceId");
      const body = nodeInterfaceUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordNodeFailure(
          c,
          "nodes.interfaces.update.failed",
          "invalid_request",
          interfaceId,
          {
            targetId: interfaceId,
            targetType: "interface",
          },
        );
        return c.json({ error: "Invalid node interface update", issues: body.error.issues }, 400);
      }

      const beforeNode = await findScopedNode(c, nodeId);

      if (!beforeNode) {
        await recordNodeFailure(c, "nodes.interfaces.update.failed", "node_not_found", nodeId, {
          targetId: interfaceId,
          targetType: "interface",
        });
        return c.json({ error: "Node not found" }, 404);
      }

      const before = interfaceSnapshot(beforeNode, interfaceId);

      if (!before) {
        await recordNodeFailure(
          c,
          "nodes.interfaces.update.failed",
          "interface_not_found",
          beforeNode.alias,
          {
            targetId: interfaceId,
            targetType: "interface",
          },
        );
        return c.json({ error: "Interface not found" }, 404);
      }

      const updated = await nodeStore
        .updateInterface(nodeId, interfaceId, body.data)
        .catch(async (error: unknown) => {
          const reason = error instanceof NodeStoreError ? error.code : "interface_update_failed";

          await recordNodeFailure(c, "nodes.interfaces.update.failed", reason, before.alias, {
            targetId: interfaceId,
            targetType: "interface",
          });
          return "unavailable" as const;
        });

      if (updated === "unavailable") {
        return c.json({ error: "Node interface update unavailable" }, 503);
      }

      const after = updated ? interfaceSnapshot(updated, interfaceId) : undefined;

      if (!updated || !after) {
        await recordNodeFailure(
          c,
          "nodes.interfaces.update.failed",
          "interface_not_found",
          before.alias,
          {
            targetId: interfaceId,
            targetType: "interface",
          },
        );
        return c.json({ error: "Interface not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "nodes.interfaces.update.succeeded",
        after,
        auth: currentAuth(c),
        before,
        details: {
          nodeAlias: beforeNode.alias,
          nodeId,
        },
        outcome: "succeeded",
        permission: "node:manage",
        target: {
          id: interfaceId,
          name: after.alias,
          type: "interface",
        },
      });

      return c.json({ data: updated });
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
      const before = await findScopedNode(c, nodeId);

      if (!before) {
        await recordNodeFailure(c, "nodes.credentials.rotate.failed", "node_not_found", nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

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
      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordNodeFailure(c, "meters.read.failed", "node_not_found", nodeId, {
          permission: "node:read",
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      const frame = (await meterFrameStore.latest(node.id)) ?? fallbackMeterFrame(node);

      if (nodeId !== frame.nodeId) {
        await recordNodeFailure(c, "meters.read.failed", "meter_node_mismatch", node.alias, {
          permission: "node:read",
          targetId: node.id,
        });
        return c.json({ error: "Meter data unavailable" }, 409);
      }

      // Strict per-channel filtering: a caller sees only the levels for channels
      // their rooms own on this (possibly shared) node.
      const visibleFrame = await filterMeterFrame(currentUser(c), node, frame);

      await recordAuditEvent(c, {
        action: "meters.read.succeeded",
        auth: currentAuth(c),
        details: {
          capturedAt: visibleFrame.capturedAt,
          interfaceId: visibleFrame.interfaceId,
          levelCount: visibleFrame.levels.length,
        },
        outcome: "succeeded",
        permission: "node:read",
        target: {
          id: node.id,
          name: node.alias,
          type: "node",
        },
      });

      return c.json({ data: visibleFrame });
    },
  );

  app.get("/api/v1/meter-events", requirePermission("node:read", "meters.stream"), (c) => {
    const user = currentUser(c);

    return streamSSE(c, async (stream) => {
      while (true) {
        const frame = await liveMeterFrame();
        // Roster-inclusive gate + strict per-channel filtering, mirroring /meters:
        // resolve the node through the caller's scoped-node set (scopedNodes — the
        // same authority /meters uses via findScopedNode), so a rostered room
        // operator with no direct node grant is admitted for the channels their
        // rooms own, while sibling-room levels on a shared node are stripped before
        // streaming.
        const visibleFrame = frame
          ? await resolveVisibleMeterFrame(user, frame, {
              filterMeterFrame,
              resolveScopedNode: scopedNode,
            })
          : undefined;

        if (visibleFrame) {
          await stream.writeSSE({
            data: JSON.stringify(visibleFrame),
            event: "meter",
          });
        }

        await stream.sleep(1000);
      }
    });
  });

  // Real usage never fabricates: when no agent frame is stored, return an empty
  // frame the UI renders as "waiting for meter frames". Synthetic data is only
  // produced when demo mode is explicitly enabled (screenshots/video/tests).
  function fallbackMeterFrame(node: RecorderNode): MeterFrame {
    if (demoMetersEnabled()) {
      return buildMeterFrame();
    }

    return {
      capturedAt: new Date().toISOString(),
      interfaceId: node.interfaces[0]?.id ?? "",
      levels: [],
      nodeId: node.id,
    };
  }

  async function liveMeterFrame() {
    const demoFrame = demoMetersEnabled() ? buildMeterFrame() : undefined;

    if (!demoFrame) {
      return undefined;
    }

    return (await meterFrameStore.latest(demoFrame.nodeId)) ?? demoFrame;
  }

  async function findScopedNode(c: Context<AppBindings>, nodeId: string) {
    return scopedNode(currentUser(c), nodeId);
  }

  // The caller's scoped-node lookup by id, mirroring /meters' findScopedNode but
  // taking a user directly so the /meter-events SSE loop (which has the user, not a
  // fresh request context per tick) can reuse the same roster-inclusive resolution.
  async function scopedNode(user: NonNullable<AuthResult["user"]>, nodeId: string) {
    return (await scopedNodes(user)).find((node) => node.id === nodeId);
  }

  async function recordNodeFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    name?: string,
    options: {
      permission?: "listen:monitor" | "node:manage" | "node:read";
      targetId?: string;
      targetType?: string;
    } = {},
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: options.permission ?? "node:manage",
      reason,
      target: {
        id: options.targetId,
        name,
        type: options.targetType ?? "node",
      },
    });
  }
}

function hasNodeUpdate(value: Record<string, unknown>) {
  return Object.entries(value).some(([key, entry]) => {
    if (key === "location") {
      return typeof entry === "object" && entry !== null && Object.keys(entry).length > 0;
    }

    return entry !== undefined;
  });
}

function nodeSnapshot(node: RecorderNode | undefined) {
  return node
    ? {
        agentVersion: node.agentVersion,
        alias: node.alias,
        audioDefaults: node.audioDefaults,
        hostname: node.hostname,
        interfaces: node.interfaces.length,
        ipAddresses: node.ipAddresses,
        location: node.location,
        notes: node.notes,
        recordingCapacity: node.recordingCapacity ?? defaultNodeRecordingCapacity,
        runtime: node.runtime,
        status: node.status,
        tags: node.tags,
      }
    : undefined;
}

function interfaceSnapshot(node: RecorderNode, interfaceId: string) {
  const audioInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);

  return audioInterface
    ? {
        alias: audioInterface.alias,
        backend: audioInterface.backend,
        channelCount: audioInterface.channelCount,
        channels: audioInterface.channels,
        hardwarePath: audioInterface.hardwarePath,
        id: audioInterface.id,
        sampleRates: audioInterface.sampleRates,
        serialNumber: audioInterface.serialNumber,
        systemName: audioInterface.systemName,
        systemRef: audioInterface.systemRef,
      }
    : undefined;
}

function credentialDetails(credential: { id: string; tokenPrefix: string }) {
  return {
    credentialId: credential.id,
    tokenPrefix: credential.tokenPrefix,
  };
}
