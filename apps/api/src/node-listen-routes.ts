import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { type MeterFrame, type RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { buildMeterFrame, demoMetersEnabled } from "./demo-data.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { ListenMonitorStore, StoredListenMonitorChunk } from "./listen-monitor-store.js";
import type { ListenSessionStore } from "./listen-session-store.js";
import type { MeterFrameStore } from "./meter-store.js";

interface NodeListenRouteDependencies {
  app: Hono<AppBindings>;
  // Whether the caller may receive the whole-node live monitor audio. The monitor
  // chunk is a single pre-mixed WAV that cannot be filtered per-channel like a
  // meter frame, so a shared-node partial owner must be refused. Defaults to
  // allow (single-room/full-authority behavior) for tests.
  canServeWholeNodeMonitor?: (
    user: NonNullable<AuthResult["user"]>,
    node: RecorderNode,
  ) => Promise<boolean>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  listenMonitorStore: ListenMonitorStore;
  listenSessionStore: ListenSessionStore;
  meterFrameStore: MeterFrameStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
}

const monitorChunkDurationMs = 1500;
const monitorChunkMaxAgeMs = 5000;
const monitorChunkSampleRate = 16_000;

export function registerNodeListenRoutes({
  app,
  canServeWholeNodeMonitor = async () => true,
  currentAuth,
  currentUser,
  listenMonitorStore,
  listenSessionStore,
  meterFrameStore,
  recordAuditEvent,
  requirePermission,
  scopedNodes,
}: NodeListenRouteDependencies) {
  app.post(
    "/api/v1/nodes/:nodeId/listen",
    requirePermission("listen:monitor", "listen.monitor.start", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordNodeFailure(c, "listen.monitor.start.failed", "node_not_found", nodeId, {
          permission: "listen:monitor",
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      // The monitor chunk is a single whole-node mix, so a caller who does not own
      // every channel's room must not receive it (they would hear another room's
      // live audio on a shared node). Meters are filtered per-channel; audio cannot
      // be, so it is refused instead.
      if (!(await canServeWholeNodeMonitor(currentUser(c), node))) {
        await recordNodeFailure(
          c,
          "listen.monitor.start.failed",
          "missing_resource_scope",
          nodeId,
          {
            permission: "listen:monitor",
            targetId: node.id,
          },
        );
        return c.json({ error: "Forbidden", permission: "listen:monitor" }, 403);
      }

      const requestBody = (await c.req.json().catch(() => undefined)) as
        | { enhance?: unknown }
        | undefined;
      const enhance = requestBody?.enhance === true;
      const sessionId = `listen_${randomUUID()}`;
      const monitorChunk = freshMonitorChunk(await listenMonitorStore.latest(node.id));
      const mode = monitorChunk ? "agent_audio_chunk" : "controller_meter_preview";
      const streamUrl = listenStreamUrl(node.id, sessionId);
      const stopUrl = listenStopUrl(node.id, sessionId);
      const targetLatencyMs = monitorChunk?.durationMs ?? monitorChunkDurationMs;
      const session = await listenSessionStore.start({
        enhance,
        mode,
        nodeId: node.id,
        sessionId,
        startedAt: new Date().toISOString(),
        stopUrl,
        streamUrl,
        targetLatencyMs,
      });

      await recordAuditEvent(c, {
        action: "listen.monitor.start.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          listenSessionId: sessionId,
        },
        details: {
          mode,
          stopUrl,
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
            enhance: session.enhance,
            mode: session.mode,
            nodeId: session.nodeId,
            sessionId: session.sessionId,
            startedAt: session.startedAt,
            stopUrl: session.stopUrl,
            streamUrl: session.streamUrl,
            targetLatencyMs: session.targetLatencyMs,
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
      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordNodeFailure(c, "listen.monitor.stream.failed", "node_not_found", nodeId, {
          permission: "listen:monitor",
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      // Same whole-node-mix isolation guard as listen start: refuse the audio to a
      // caller who does not own every channel's room on a shared node.
      if (!(await canServeWholeNodeMonitor(currentUser(c), node))) {
        await recordNodeFailure(
          c,
          "listen.monitor.stream.failed",
          "missing_resource_scope",
          nodeId,
          { permission: "listen:monitor", targetId: node.id },
        );
        return c.json({ error: "Forbidden", permission: "listen:monitor" }, 403);
      }

      const sessionId = c.req.query("sessionId");
      const session = sessionId ? await listenSessionStore.find(node.id, sessionId) : undefined;

      if (!session) {
        await recordNodeFailure(
          c,
          "listen.monitor.stream.failed",
          sessionId ? "session_not_found" : "session_required",
          node.alias,
          {
            permission: "listen:monitor",
            targetId: node.id,
          },
        );
        return c.json({ error: "Listen session not found" }, sessionId ? 404 : 400);
      }

      // Prefer the enhanced rendition when the session requested it and a fresh
      // enhanced chunk exists; otherwise fall back to the raw monitor chunk.
      const enhancedChunk = session.enhance
        ? freshMonitorChunk(await listenMonitorStore.latest(node.id, "enhanced"))
        : undefined;
      const monitorChunk =
        enhancedChunk ?? freshMonitorChunk(await listenMonitorStore.latest(node.id, "raw"));
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

  app.delete(
    "/api/v1/nodes/:nodeId/listen/:sessionId",
    requirePermission("listen:monitor", "listen.monitor.stop", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const sessionId = c.req.param("sessionId");
      const node = await findScopedNode(c, nodeId);

      if (!node) {
        await recordNodeFailure(c, "listen.monitor.stop.failed", "node_not_found", nodeId, {
          permission: "listen:monitor",
          targetId: nodeId,
        });
        return c.json({ error: "Node not found" }, 404);
      }

      const session = await listenSessionStore.stop(node.id, sessionId);

      if (!session) {
        await recordNodeFailure(c, "listen.monitor.stop.failed", "session_not_found", node.alias, {
          permission: "listen:monitor",
          targetId: node.id,
        });
        return c.json({ error: "Listen session not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "listen.monitor.stop.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          listenSessionId: sessionId,
        },
        details: {
          endedAt: session.endedAt,
          mode: session.mode,
          startedAt: session.startedAt,
        },
        outcome: "succeeded",
        permission: "listen:monitor",
        target: {
          id: node.id,
          name: node.alias,
          type: "node",
        },
      });

      return c.json({ data: session });
    },
  );

  async function monitorMeterFrame(nodeId: string) {
    const frame = await meterFrameStore.latest(nodeId);

    if (frame) {
      return frame;
    }

    if (!demoMetersEnabled()) {
      return undefined;
    }

    const seededFrame = buildMeterFrame();

    return seededFrame.nodeId === nodeId ? seededFrame : undefined;
  }

  async function findScopedNode(c: Context<AppBindings>, nodeId: string) {
    return (await scopedNodes(currentUser(c))).find((node) => node.id === nodeId);
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

function listenStreamUrl(nodeId: string, sessionId: string) {
  return `/api/v1/nodes/${encodeURIComponent(nodeId)}/listen/stream?sessionId=${encodeURIComponent(sessionId)}`;
}

function listenStopUrl(nodeId: string, sessionId: string) {
  return `/api/v1/nodes/${encodeURIComponent(nodeId)}/listen/${encodeURIComponent(sessionId)}`;
}

function freshMonitorChunk(chunk: StoredListenMonitorChunk | undefined, now = Date.now()) {
  if (!chunk) {
    return undefined;
  }

  const capturedAt = Date.parse(chunk.capturedAt);

  if (!Number.isFinite(capturedAt)) {
    return undefined;
  }

  return Math.abs(now - capturedAt) <= monitorChunkMaxAgeMs ? chunk : undefined;
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
