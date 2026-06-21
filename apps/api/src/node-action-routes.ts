import type { Context, Hono } from "hono";
import type { Permission, RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { isUuid } from "./auth-utils.js";
import type { AppBindings, RequirePermission } from "./http-types.js";
import type { ListenMonitorStore, StoredListenMonitorChunk } from "./listen-monitor-store.js";
import type { MeterFrameStore } from "./meter-store.js";

interface NodeActionRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  listenMonitorStore: ListenMonitorStore;
  meterFrameStore: MeterFrameStore;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
}

interface NodeActionState {
  enabled: boolean;
  href?: string;
  method: "GET" | "PATCH" | "POST";
  permission: Permission;
  reason?: string;
}

const monitorChunkMaxAgeMs = 5000;
const unavailableNodeStatuses = new Set<RecorderNode["status"]>(["offline"]);

export function registerNodeActionRoutes({
  app,
  currentUser,
  listenMonitorStore,
  meterFrameStore,
  requirePermission,
  scopedNodes,
}: NodeActionRouteDependencies) {
  app.get(
    "/api/v1/nodes/:nodeId/actions",
    requirePermission("node:read", "nodes.actions.read", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const user = currentUser(c);
      const node = (await scopedNodes(user)).find((candidate) => candidate.id === nodeId);

      if (!node) {
        return c.json({ error: "Node not found" }, 404);
      }

      const [monitorChunk, meterFrame] = await Promise.all([
        listenMonitorStore.latest(node.id),
        meterFrameStore.latest(node.id),
      ]);
      const monitor = nodeMonitorSource(freshMonitorChunk(monitorChunk), meterFrame?.capturedAt);

      return c.json({
        data: {
          actions: nodeActions(node, user.permissions, {
            listen: monitor.available,
            meters: Boolean(meterFrame),
          }),
          links: nodeActionLinks(node),
          monitor,
          node,
        },
      });
    },
  );
}

function nodeActions(
  node: RecorderNode,
  permissions: readonly Permission[],
  readiness: { listen: boolean; meters: boolean },
) {
  const basePath = `/api/v1/nodes/${node.id}`;
  const nodeAvailable = !unavailableNodeStatuses.has(node.status);

  return {
    detail: actionState({
      href: basePath,
      method: "GET",
      permission: "node:read",
      permissions,
      ready: true,
    }),
    editNode: actionState({
      href: basePath,
      method: "PATCH",
      permission: "node:manage",
      permissions,
      ready: true,
    }),
    health: actionState({
      href: `/api/v1/health-events?nodeId=${encodeURIComponent(node.id)}`,
      method: "GET",
      permission: "health:read",
      permissions,
      ready: true,
    }),
    listen: actionState({
      href: `${basePath}/listen`,
      method: "POST",
      permission: "listen:monitor",
      permissions,
      ready: nodeAvailable && readiness.listen,
      reason: nodeAvailable ? "monitor_source_unavailable" : "node_offline",
    }),
    meters: actionState({
      href: `${basePath}/meters`,
      method: "GET",
      permission: "node:read",
      permissions,
      ready: nodeAvailable && readiness.meters,
      reason: nodeAvailable ? "meter_frame_not_found" : "node_offline",
    }),
    rotateCredential: actionState({
      href: `${basePath}/credentials/rotate`,
      method: "POST",
      permission: "node:manage",
      permissions,
      ready: isUuid(node.id),
      reason: "node_not_persisted",
    }),
    startRecording: actionState({
      href: "/api/v1/recordings",
      method: "POST",
      permission: "recording:create",
      permissions,
      ready: nodeAvailable,
      reason: "node_offline",
    }),
  };
}

function actionState({
  href,
  method,
  permission,
  permissions,
  ready,
  reason,
}: {
  href?: string;
  method: NodeActionState["method"];
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): NodeActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason };
}

function nodeActionLinks(node: RecorderNode) {
  const basePath = `/api/v1/nodes/${node.id}`;

  return {
    credentialsRotate: `${basePath}/credentials/rotate`,
    detail: basePath,
    healthEvents: `/api/v1/health-events?nodeId=${encodeURIComponent(node.id)}`,
    interfaces: node.interfaces.map((audioInterface) => ({
      href: `${basePath}/interfaces/${audioInterface.id}`,
      id: audioInterface.id,
    })),
    listenStart: `${basePath}/listen`,
    meters: `${basePath}/meters`,
    recordingStart: "/api/v1/recordings",
    update: basePath,
  };
}

function nodeMonitorSource(chunk: StoredListenMonitorChunk | undefined, meterCapturedAt?: string) {
  if (chunk) {
    return {
      available: true,
      capturedAt: chunk.capturedAt,
      contentType: chunk.contentType,
      durationMs: chunk.durationMs,
      source: chunk.source,
    };
  }

  if (meterCapturedAt) {
    return {
      available: true,
      capturedAt: meterCapturedAt,
      source: "meter_frame" as const,
    };
  }

  return {
    available: false,
  };
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
