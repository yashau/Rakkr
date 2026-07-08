import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { CurrentUser, MeterFrame, Permission, RecorderNode } from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { ListenMonitorStore } from "../src/listen-monitor-store.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeStore } from "../src/node-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { registerNodeRoutes } = await import("../src/node-routes.js");

test("node action summary returns ready actions links and monitor context", async () => {
  const recorder = nodeWithInterface({ id: randomUUID() });
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const listenMonitorStore = createListenMonitorStore();
  const capturedAt = new Date().toISOString();

  await listenMonitorStore.save({
    audio: wavChunk(),
    capturedAt,
    contentType: "audio/wav",
    durationMs: 900,
    nodeId: recorder.id,
  });

  const app = nodeActionsApp({
    listenMonitorStore,
    auditStore,
    nodes: [recorder],
    permissionCalls,
    user: user(["health:read", "listen:monitor", "node:manage", "node:read", "recording:create"]),
  });

  const response = await app.request(`/api/v1/nodes/${recorder.id}/actions`);
  const body = (await response.json()) as NodeActionsResponse;

  assert.equal(response.status, 200);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.actions.read",
    permission: "node:read",
    target: { id: recorder.id, type: "node" },
  });
  assert.equal(body.data.node.id, recorder.id);
  assert.equal(body.data.monitor.available, true);
  assert.equal(body.data.monitor.source, "agent_audio_chunk");
  assert.equal(body.data.monitor.capturedAt, capturedAt);
  assert.equal(body.data.actions.detail.enabled, true);
  assert.equal(body.data.actions.editNode.enabled, true);
  assert.equal(body.data.actions.health.enabled, true);
  assert.equal(body.data.actions.listen.enabled, true);
  assert.equal(body.data.actions.meters.enabled, true);
  assert.equal(body.data.actions.rotateCredential.enabled, true);
  assert.equal(body.data.actions.startRecording.enabled, true);
  assert.equal(body.data.links.listenStart, `/api/v1/nodes/${recorder.id}/listen`);
  assert.equal(
    body.data.links.interfaces[0]?.href,
    `/api/v1/nodes/${recorder.id}/interfaces/iface_monitor`,
  );

  const [event] = await auditStore.list({ action: "nodes.actions.read.succeeded" });

  assert.equal(event?.outcome, "succeeded");
  assert.equal(event?.permission, "node:read");
  assert.equal(event?.target.id, recorder.id);
  assert.equal(event?.target.name, recorder.alias);
  assert.equal(event?.details.monitorAvailable, true);
  assert.equal(event?.details.monitorSource, "agent_audio_chunk");
  assert.equal(event?.details.visibleActionCount, 7);
});

test("node action summary explains permission and lifecycle blockers", async () => {
  const recorder = nodeWithInterface({ id: "node_seed", status: "offline" });
  const app = nodeActionsApp({
    meterFrames: [],
    nodes: [recorder],
    permissionCalls: [],
    user: user(["node:read"]),
  });

  const response = await app.request(`/api/v1/nodes/${recorder.id}/actions`);
  const body = (await response.json()) as NodeActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.monitor.available, false);
  assert.equal(body.data.actions.detail.enabled, true);
  assert.equal(body.data.actions.listen.enabled, false);
  assert.equal(body.data.actions.listen.reason, "missing_permission");
  assert.equal(body.data.actions.editNode.reason, "missing_permission");
  assert.equal(body.data.actions.health.reason, "missing_permission");
  assert.equal(body.data.actions.rotateCredential.reason, "missing_permission");
  assert.equal(body.data.actions.startRecording.reason, "missing_permission");
  assert.equal(body.data.actions.meters.enabled, false);
  assert.equal(body.data.actions.meters.reason, "node_offline");
});

test("node action summary marks a provisioning node unavailable with an accurate reason", async () => {
  // A provisioning node has never sent a heartbeat, so it cannot record/listen/
  // meter — but the reason must say "provisioning", not "offline" (it has never
  // been online), so operators are not misled into troubleshooting a downed node.
  const recorder = nodeWithInterface({ id: "node_provisioning", status: "provisioning" });
  const app = nodeActionsApp({
    meterFrames: [],
    nodes: [recorder],
    permissionCalls: [],
    user: user(["listen:monitor", "node:read", "recording:create"]),
  });

  const response = await app.request(`/api/v1/nodes/${recorder.id}/actions`);
  const body = (await response.json()) as NodeActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.actions.listen.enabled, false);
  assert.equal(body.data.actions.listen.reason, "node_provisioning");
  assert.equal(body.data.actions.meters.enabled, false);
  assert.equal(body.data.actions.meters.reason, "node_provisioning");
  assert.equal(body.data.actions.startRecording.enabled, false);
  assert.equal(body.data.actions.startRecording.reason, "node_provisioning");
});

test("node action summary separates listen source from meter readiness", async () => {
  const recorder = nodeWithInterface({ id: "node_chunk_only" });
  const listenMonitorStore = createListenMonitorStore();

  await listenMonitorStore.save({
    audio: wavChunk(),
    capturedAt: new Date().toISOString(),
    contentType: "audio/wav",
    durationMs: 900,
    nodeId: recorder.id,
  });

  const app = nodeActionsApp({
    listenMonitorStore,
    meterFrames: [],
    nodes: [recorder],
    permissionCalls: [],
    user: user(["listen:monitor", "node:read"]),
  });

  const response = await app.request(`/api/v1/nodes/${recorder.id}/actions`);
  const body = (await response.json()) as NodeActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.actions.listen.enabled, true);
  assert.equal(body.data.actions.meters.enabled, false);
  assert.equal(body.data.actions.meters.reason, "meter_frame_not_found");
});

test("node action summary hides nodes outside scoped visibility", async () => {
  const recorder = nodeWithInterface({ id: "node_hidden" });
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = nodeActionsApp({
    auditStore,
    nodes: [recorder],
    permissionCalls,
    scopedNodeIds: [],
    user: user(["node:read"]),
  });

  const response = await app.request(`/api/v1/nodes/${recorder.id}/actions`);

  assert.equal(response.status, 404);
  assert.deepEqual(permissionCalls.at(-1)?.target, { id: recorder.id, type: "node" });

  const [event] = await auditStore.list({ action: "nodes.actions.read.failed" });

  assert.equal(event?.outcome, "failed");
  assert.equal(event?.permission, "node:read");
  assert.equal(event?.reason, "not_found");
  assert.equal(event?.target.id, recorder.id);
});

interface NodeActionsResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; reason?: string }>;
    links: {
      interfaces: Array<{ href: string; id: string }>;
      listenStart: string;
    };
    monitor: {
      available: boolean;
      capturedAt?: string;
      source?: string;
    };
    node: RecorderNode;
  };
}

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function nodeActionsApp({
  auditStore = createAuditStore(""),
  listenMonitorStore = createListenMonitorStore(),
  meterFrames,
  nodes,
  permissionCalls,
  scopedNodeIds,
  user: currentUser,
}: {
  auditStore?: ReturnType<typeof createAuditStore>;
  listenMonitorStore?: ListenMonitorStore;
  meterFrames?: MeterFrame[];
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
  scopedNodeIds?: string[];
  user: CurrentUser;
}) {
  const app = new Hono<AppBindings>();

  registerNodeRoutes({
    app,
    currentAuth: () => auth(currentUser),
    currentUser: () => currentUser,
    hasResourceScope: async () => true,
    listenMonitorStore,
    listenSessionStore: {
      async find() {
        return undefined;
      },
      async start() {
        throw new Error("not implemented");
      },
      async stop() {
        return undefined;
      },
    },
    meterFrameStore: memoryMeterFrameStore(meterFrames ?? [meterFrame(nodes[0]?.id)]),
    nodeStore: memoryNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () =>
      nodes.filter(
        (candidate) => scopedNodeIds === undefined || scopedNodeIds.includes(candidate.id),
      ),
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    calls.push({
      action,
      permission,
      target: target ? await target(c) : undefined,
    });
    await next();
  };
}

function auth(currentUser: CurrentUser): AuthResult {
  return { user: currentUser };
}

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "node-action@example.com",
    groups: [],
    id: "user_node_action",
    name: "Node Action User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    return auditStore.append({
      action: input.action,
      actor: {
        id: "user_node_action",
        name: "Node Action User",
        roles: ["operator"],
        type: "user",
      },
      actorContext: {},
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    });
  };
}

function memoryMeterFrameStore(frames: MeterFrame[]): MeterFrameStore {
  return {
    async history(nodeId, limit = frames.length) {
      return frames.filter((frame) => frame.nodeId === nodeId).slice(0, limit);
    },
    async latest(nodeId) {
      return frames.find((frame) => frame.nodeId === nodeId);
    },
    async save(frame) {
      frames.unshift(frame);

      return {
        frame,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

function memoryNodeStore(nodes: RecorderNode[]): NodeStore {
  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return nodes;
    },
    async rotateCredential() {
      throw new Error("not implemented");
    },
    async updateInterface() {
      throw new Error("not implemented");
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

function nodeWithInterface(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Monitor Room",
    hostname: "monitor-room-node",
    id: "node_monitor_room",
    interfaces: [
      {
        alias: "Monitor USB",
        backend: "alsa",
        channelCount: 2,
        channels: [
          { alias: "Channel 1", index: 1 },
          { alias: "Channel 2", index: 2 },
        ],
        hardwarePath: "/proc/asound/card1/pcm0c",
        id: "iface_monitor",
        sampleRates: [48_000],
        serialNumber: "MONITOR-USB-1",
        systemName: "Monitor USB Interface",
        systemRef: "usb-1-1",
      },
    ],
    ipAddresses: ["10.0.0.50"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Monitor Room",
      site: "Main Site",
    },
    status: "online",
    tags: ["voice"],
    ...input,
  };
}

function meterFrame(nodeId = "node_monitor_room"): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:00:00.000Z",
    interfaceId: "iface_monitor",
    levels: [],
    nodeId,
  };
}

function wavChunk() {
  const bytes = Buffer.alloc(48);

  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVE", 8);

  return bytes;
}
