import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  defaultNodeRecordingCapacity,
  nodeRecordingCapacitySchema,
  nodeRuntimeSchema,
  nodeStatusSchema,
  type MeterFrame,
  type RecorderNode,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { buildMeterFrame } from "./demo-data.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { ListenMonitorStore } from "./listen-monitor-store.js";
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
  listenMonitorStore: ListenMonitorStore;
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
const nodeSearchSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(200).optional(),
);
const nodeListFilterSchema = z
  .object({
    q: nodeSearchSchema,
    status: nodeStatusSchema.optional(),
  })
  .strict();
const monitorChunkDurationMs = 1500;
const monitorChunkSampleRate = 16_000;

export function registerNodeRoutes({
  app,
  currentAuth,
  currentUser,
  hasResourceScope,
  listenMonitorStore,
  meterFrameStore,
  nodeStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
}: NodeRouteDependencies) {
  app.get("/api/v1/nodes", requirePermission("node:read", "nodes.read"), async (c) => {
    const filters = nodeListFilterSchema.safeParse(c.req.query());

    if (!filters.success) {
      return c.json({ error: "Invalid node filters", issues: filters.error.issues }, 400);
    }

    const nodes = await scopedNodes(currentUser(c));
    const query = normalizeSearchTerm(filters.data.q);
    const filteredNodes = nodes.filter(
      (node) =>
        (!filters.data.status || node.status === filters.data.status) &&
        (!query || nodeSearchText(node).includes(query)),
    );

    return c.json({ data: filteredNodes });
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

      const before = await nodeStore.find(nodeId);

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

      const beforeNode = await nodeStore.find(nodeId);

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
      const nodeId = c.req.param("nodeId");
      const node = await nodeStore.find(nodeId);

      if (!node) {
        await recordNodeFailure(c, "listen.monitor.start.failed", "node_not_found", nodeId, {
          permission: "listen:monitor",
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      const sessionId = `listen_${randomUUID()}`;
      const monitorChunk = await listenMonitorStore.latest(node.id);
      const mode = monitorChunk ? "agent_audio_chunk" : "controller_meter_preview";
      const streamUrl = listenStreamUrl(node.id, sessionId);
      const targetLatencyMs = monitorChunk?.durationMs ?? monitorChunkDurationMs;

      await recordAuditEvent(c, {
        action: "listen.monitor.start.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          listenSessionId: sessionId,
        },
        details: {
          mode,
          streamUrl,
          targetLatencyMs,
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
            mode,
            nodeId: node.id,
            sessionId,
            startedAt: new Date().toISOString(),
            streamUrl,
            targetLatencyMs,
          },
        },
        202,
      );
    },
  );

  app.get(
    "/api/v1/nodes/:nodeId/listen/stream",
    requirePermission("listen:monitor", "listen.monitor.stream", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const node = await nodeStore.find(nodeId);

      if (!node) {
        await recordNodeFailure(c, "listen.monitor.stream.failed", "node_not_found", nodeId, {
          permission: "listen:monitor",
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      const monitorChunk = await listenMonitorStore.latest(node.id);
      const frame = monitorChunk ? undefined : await monitorMeterFrame(node.id);

      if (!monitorChunk && !frame) {
        await recordNodeFailure(
          c,
          "listen.monitor.stream.failed",
          "meter_frame_not_found",
          node.alias,
          {
            permission: "listen:monitor",
            targetId: node.id,
          },
        );
        return c.json({ error: "Monitor data unavailable" }, 409);
      }

      const chunk = monitorChunk?.audio ?? monitorWavChunk(frame as MeterFrame);
      const sessionId = c.req.query("sessionId");
      const sourceCapturedAt = monitorChunk?.capturedAt ?? (frame as MeterFrame).capturedAt;
      const durationMs = monitorChunk?.durationMs ?? monitorChunkDurationMs;
      const mode = monitorChunk?.source ?? "controller_meter_preview";

      await recordAuditEvent(c, {
        action: "listen.monitor.stream.succeeded",
        auth: currentAuth(c),
        correlationIds: sessionId ? { listenSessionId: sessionId } : undefined,
        details: {
          durationMs,
          mode,
          sourceCapturedAt,
        },
        outcome: "succeeded",
        permission: "listen:monitor",
        target: {
          id: node.id,
          name: node.alias,
          type: "node",
        },
      });

      return c.body(new Uint8Array(chunk), 200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `inline; filename="${node.id}-monitor.wav"`,
        "Content-Length": chunk.byteLength.toString(),
        "Content-Type": monitorChunk?.contentType ?? "audio/wav",
      });
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

  async function monitorMeterFrame(nodeId: string) {
    const frame = await meterFrameStore.latest(nodeId);

    if (frame) {
      return frame;
    }

    const seededFrame = buildMeterFrame();

    return seededFrame.nodeId === nodeId ? seededFrame : undefined;
  }

  async function recordNodeFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    name?: string,
    options: {
      permission?: "listen:monitor" | "node:manage";
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

function listenStreamUrl(nodeId: string, sessionId: string) {
  return `/api/v1/nodes/${encodeURIComponent(nodeId)}/listen/stream?sessionId=${encodeURIComponent(sessionId)}`;
}

function hasNodeUpdate(value: Record<string, unknown>) {
  return Object.entries(value).some(([key, entry]) => {
    if (key === "location") {
      return typeof entry === "object" && entry !== null && Object.keys(entry).length > 0;
    }

    return entry !== undefined;
  });
}

function normalizeSearchTerm(value: string | undefined) {
  return value?.trim().toLowerCase();
}

function nodeSearchText(node: RecorderNode) {
  return [
    node.id,
    node.alias,
    node.hostname,
    node.agentVersion,
    node.status,
    node.notes,
    node.ipAddresses,
    node.tags,
    Object.values(node.location),
    node.runtime
      ? [
          node.runtime.architecture,
          node.runtime.audioBackends,
          node.runtime.kernelRelease,
          node.runtime.osName,
          node.runtime.uptimeSeconds === undefined ? undefined : String(node.runtime.uptimeSeconds),
        ]
      : undefined,
    node.interfaces.map((audioInterface) => [
      audioInterface.alias,
      audioInterface.backend,
      String(audioInterface.channelCount),
      audioInterface.hardwarePath,
      audioInterface.id,
      audioInterface.sampleRates.map(String),
      audioInterface.serialNumber,
      audioInterface.systemName,
      audioInterface.systemRef,
      audioInterface.channels.map((channel) => [channel.alias, String(channel.index)]),
    ]),
  ]
    .flat(4)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function monitorWavChunk(frame: MeterFrame) {
  const sampleCount = Math.round((monitorChunkSampleRate * monitorChunkDurationMs) / 1000);
  const dataBytes = sampleCount * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  const amplitude = monitorAmplitude(frame);

  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(monitorChunkSampleRate, 24);
  bytes.writeUInt32LE(monitorChunkSampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const phase = (2 * Math.PI * 440 * index) / monitorChunkSampleRate;
    const sample = Math.round(Math.sin(phase) * amplitude * 32767);

    bytes.writeInt16LE(sample, 44 + index * 2);
  }

  return bytes;
}

function monitorAmplitude(frame: MeterFrame) {
  const peakDbfs = Math.max(-90, ...frame.levels.map((level) => level.peakDbfs));
  const linear = 10 ** (peakDbfs / 20);

  return Math.max(0.02, Math.min(0.25, linear));
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
