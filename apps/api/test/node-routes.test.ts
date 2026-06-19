import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, MeterFrame, Permission, RecorderNode } from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeInterfaceUpdateInput, NodeStore, NodeUpdateInput } from "../src/node-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerNodeRoutes } = await import("../src/node-routes.js");

test("node list filters by status", async () => {
  const auditStore = createAuditStore("");
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes: [
      node({ alias: "Online Room", id: "node_online", status: "online" }),
      node({ alias: "Offline Room", id: "node_offline", status: "offline" }),
    ],
    permissionCalls: [],
  });

  const response = await app.request("/api/v1/nodes?status=offline");
  const body = (await response.json()) as { data: RecorderNode[] };
  const invalidResponse = await app.request("/api/v1/nodes?status=unknown");

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((item) => item.id),
    ["node_offline"],
  );
  assert.equal(invalidResponse.status, 400);
});

test("node list searches inventory identity fields", async () => {
  const auditStore = createAuditStore("");
  const chamberNode = nodeWithInterface({
    alias: "Council Chamber",
    id: "node_chamber",
    location: {
      building: "City Hall",
      room: "Council Room",
      site: "Main Site",
    },
    status: "recording",
    tags: ["voice", "public-meeting"],
  });
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes: [node({ id: "node_monitor" }), chamberNode],
    permissionCalls: [],
  });

  const searchResponse = await app.request("/api/v1/nodes?q=MONITOR-USB-1");
  const searchBody = (await searchResponse.json()) as { data: RecorderNode[] };
  const combinedResponse = await app.request("/api/v1/nodes?status=recording&q=city");
  const combinedBody = (await combinedResponse.json()) as { data: RecorderNode[] };

  assert.equal(searchResponse.status, 200);
  assert.deepEqual(
    searchBody.data.map((item) => item.id),
    ["node_chamber"],
  );
  assert.equal(combinedResponse.status, 200);
  assert.deepEqual(
    combinedBody.data.map((item) => item.id),
    ["node_chamber"],
  );
});

test("listen start returns a monitor stream URL and audits access", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    nodes: [node()],
    permissionCalls,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/listen`, { method: "POST" });
  const body = (await response.json()) as {
    data: { mode: string; sessionId: string; streamUrl: string; targetLatencyMs: number };
  };
  const [event] = await auditStore.list({ action: "listen.monitor.start.succeeded" });

  assert.equal(response.status, 202);
  assert.equal(body.data.mode, "controller_meter_preview");
  assert.equal(body.data.targetLatencyMs, 1500);
  assert.match(body.data.streamUrl, new RegExp(`/api/v1/nodes/${node().id}/listen/stream`));
  assert.match(body.data.streamUrl, /sessionId=listen_/);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "listen.monitor.start",
    permission: "listen:monitor",
    target: { id: node().id, type: "node" },
  });
  assert.equal(event?.details.streamUrl, body.data.streamUrl);
  assert.equal(event?.correlationIds?.listenSessionId, body.data.sessionId);
});

test("listen stream returns a short wav preview derived from meter levels", async () => {
  const auditStore = createAuditStore("");
  const app = nodeApp({
    auditStore,
    frames: [meterFrame()],
    nodes: [node()],
    permissionCalls: [],
  });

  const response = await app.request(
    `/api/v1/nodes/${node().id}/listen/stream?sessionId=listen_test`,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const [event] = await auditStore.list({ action: "listen.monitor.stream.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16_000);
  assert.equal(bytes.readUInt32LE(40), 48_000);
  assert.equal(event?.correlationIds?.listenSessionId, "listen_test");
  assert.equal(event?.details.mode, "controller_meter_preview");
});

test("listen stream reports unavailable monitor data", async () => {
  const auditStore = createAuditStore("");
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes: [node()],
    permissionCalls: [],
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/listen/stream`);
  const [event] = await auditStore.list({ action: "listen.monitor.stream.failed" });

  assert.equal(response.status, 409);
  assert.equal(event?.reason, "meter_frame_not_found");
  assert.equal(event?.target.id, node().id);
});

test("node update changes identity fields and audits before and after", async () => {
  const auditStore = createAuditStore("");
  const nodes = [node()];
  const permissionCalls: PermissionCall[] = [];
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes,
    permissionCalls,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}`, {
    body: JSON.stringify({
      alias: "Council Chamber Recorder",
      ipAddresses: ["10.0.0.51"],
      location: {
        building: "City Hall",
        floor: "2",
        room: "Council Chamber",
        site: "Main Site",
      },
      notes: "Rack shelf A",
      tags: ["voice", "council"],
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: RecorderNode };
  const [event] = await auditStore.list({ action: "nodes.update.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.data.alias, "Council Chamber Recorder");
  assert.equal(body.data.location.building, "City Hall");
  assert.equal(body.data.location.floor, "2");
  assert.equal(body.data.location.room, "Council Chamber");
  assert.deepEqual(body.data.ipAddresses, ["10.0.0.51"]);
  assert.deepEqual(body.data.tags, ["voice", "council"]);
  assert.equal(body.data.notes, "Rack shelf A");
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.update",
    permission: "node:manage",
    target: { id: node().id, type: "node" },
  });
  assert.equal(event?.before?.alias, "Monitor Room");
  assert.equal(event?.after?.alias, "Council Chamber Recorder");
  assert.equal(event?.permission, "node:manage");
});

test("node interface update changes device and channel aliases and audits before and after", async () => {
  const auditStore = createAuditStore("");
  const nodes = [nodeWithInterface()];
  const permissionCalls: PermissionCall[] = [];
  const app = nodeApp({
    auditStore,
    frames: [],
    nodes,
    permissionCalls,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/interfaces/iface_monitor`, {
    body: JSON.stringify({
      alias: "Lectern USB",
      channels: [{ alias: "Lectern Mic", index: 1 }],
      hardwarePath: "/proc/asound/card2/pcm0c",
      sampleRates: [48000, 44100],
      serialNumber: "X32-USB-1234",
      systemName: "hw:2,0",
      systemRef: "usb-2-1",
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: RecorderNode };
  const [event] = await auditStore.list({ action: "nodes.interfaces.update.succeeded" });
  const [audioInterface] = body.data.interfaces;

  assert.equal(response.status, 200);
  assert.equal(audioInterface.alias, "Lectern USB");
  assert.equal(audioInterface.hardwarePath, "/proc/asound/card2/pcm0c");
  assert.equal(audioInterface.serialNumber, "X32-USB-1234");
  assert.equal(audioInterface.systemName, "hw:2,0");
  assert.equal(audioInterface.systemRef, "usb-2-1");
  assert.deepEqual(audioInterface.sampleRates, [48000, 44100]);
  assert.deepEqual(audioInterface.channels, [
    { alias: "Lectern Mic", index: 1 },
    { alias: "Channel 2", index: 2 },
  ]);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.interfaces.update",
    permission: "node:manage",
    target: { id: "iface_monitor", type: "interface" },
  });
  assert.equal(event?.before?.alias, "Monitor USB");
  assert.equal(event?.after?.alias, "Lectern USB");
  assert.equal(event?.target.type, "interface");
  assert.equal(event?.details.nodeId, node().id);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function nodeApp({
  auditStore,
  frames,
  nodes,
  permissionCalls,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  frames: MeterFrame[];
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
}) {
  const app = new Hono<AppBindings>();

  registerNodeRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    hasResourceScope: async () => true,
    meterFrameStore: memoryMeterFrameStore(frames),
    nodeStore: memoryNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => nodes,
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => {
    return async (c, next) => {
      calls.push({
        action,
        permission,
        target: target ? await target(c) : undefined,
      });
      await next();
    };
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_node_route",
        name: "Node Route User",
        roles: ["operator"],
        type: "user",
      },
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function memoryMeterFrameStore(frames: MeterFrame[]): MeterFrameStore {
  return {
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
    async updateInterface(nodeId: string, interfaceId: string, input: NodeInterfaceUpdateInput) {
      const index = nodes.findIndex((candidate) => candidate.id === nodeId);

      if (index < 0) {
        return undefined;
      }

      const interfaceIndex = nodes[index].interfaces.findIndex(
        (candidate) => candidate.id === interfaceId,
      );

      if (interfaceIndex < 0) {
        return undefined;
      }

      const audioInterface = nodes[index].interfaces[interfaceIndex];
      const channelAliases = new Map(
        (input.channels ?? []).map((channel) => [channel.index, channel.alias]),
      );
      const interfaces = [...nodes[index].interfaces];

      interfaces[interfaceIndex] = {
        ...audioInterface,
        alias: input.alias ?? audioInterface.alias,
        channels: audioInterface.channels.map((channel) => ({
          ...channel,
          alias: channelAliases.get(channel.index) ?? channel.alias,
        })),
        hardwarePath:
          input.hardwarePath === undefined
            ? audioInterface.hardwarePath
            : (input.hardwarePath ?? undefined),
        sampleRates: input.sampleRates ?? audioInterface.sampleRates,
        serialNumber:
          input.serialNumber === undefined
            ? audioInterface.serialNumber
            : (input.serialNumber ?? undefined),
        systemName: input.systemName ?? audioInterface.systemName,
        systemRef: input.systemRef ?? audioInterface.systemRef,
      };
      nodes[index] = {
        ...nodes[index],
        interfaces,
      };

      return nodes[index];
    },
    async update(nodeId, input: NodeUpdateInput) {
      const index = nodes.findIndex((candidate) => candidate.id === nodeId);

      if (index < 0) {
        return undefined;
      }

      nodes[index] = {
        ...nodes[index],
        alias: input.alias ?? nodes[index].alias,
        hostname: input.hostname ?? nodes[index].hostname,
        ipAddresses: input.ipAddresses ?? nodes[index].ipAddresses,
        location: {
          ...nodes[index].location,
          ...input.location,
        },
        notes: input.notes === undefined ? nodes[index].notes : (input.notes ?? undefined),
        tags: input.tags ?? nodes[index].tags,
      };

      return nodes[index];
    },
  };
}

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "node-route@example.com",
    groups: [],
    id: "user_node_route",
    name: "Node Route User",
    permissions: ["listen:monitor", "node:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Monitor Room",
    hostname: "monitor-room-node",
    id: "node_monitor_room",
    interfaces: [],
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

function nodeWithInterface(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    ...node(),
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
    ...input,
  };
}

function meterFrame(): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:00:00.000Z",
    interfaceId: "iface_monitor",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Mic 1",
        peakDbfs: -12,
        rmsDbfs: -24,
      },
    ],
    nodeId: node().id,
  };
}
