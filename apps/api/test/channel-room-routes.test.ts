import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecorderNode, Room } from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { RoomStore } from "../src/room-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { registerChannelRoomRoutes } = await import("../src/channel-room-routes.js");

test("assigns channels to rooms and audits before/after", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = channelRoomApp({ auditStore, nodes: [sharedNode()], permissionCalls });

  const response = await app.request(`/api/v1/nodes/${sharedNode().id}/channel-rooms`, {
    body: JSON.stringify({
      assignments: [
        { channelIndexes: [1, 2], interfaceId: "iface-1", roomId: "room-a" },
        { channelIndexes: [3], interfaceId: "iface-1", roomId: "room-b" },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const body = (await response.json()) as { data: RecorderNode };
  const [event] = await auditStore.list({ action: "nodes.channel-rooms.assign.succeeded" });
  const channels = body.data.interfaces[0].channels;

  assert.equal(response.status, 200);
  assert.equal(channels.find((channel) => channel.index === 1)?.roomId, "room-a");
  assert.equal(channels.find((channel) => channel.index === 2)?.roomId, "room-a");
  assert.equal(channels.find((channel) => channel.index === 3)?.roomId, "room-b");
  assert.equal(channels.find((channel) => channel.index === 4)?.roomId, undefined);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.channel-rooms.assign",
    permission: "node:manage",
    target: { id: sharedNode().id, type: "node" },
  });
  assert.equal(event?.details.channelCount, 3);
  assert.deepEqual(event?.details.assignedRoomIds, ["room-a", "room-b"]);
});

test("clears a channel room with a null assignment", async () => {
  const auditStore = createAuditStore("");
  const app = channelRoomApp({ auditStore, nodes: [sharedNode()], permissionCalls: [] });
  const path = `/api/v1/nodes/${sharedNode().id}/channel-rooms`;

  await app.request(path, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: "room-a" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const cleared = await app.request(path, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: null }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const body = (await cleared.json()) as { data: RecorderNode };

  assert.equal(cleared.status, 200);
  assert.equal(body.data.interfaces[0].channels[0].roomId, undefined);
});

test("rejects an unknown room", async () => {
  const auditStore = createAuditStore("");
  const app = channelRoomApp({ auditStore, nodes: [sharedNode()], permissionCalls: [] });

  const response = await app.request(`/api/v1/nodes/${sharedNode().id}/channel-rooms`, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: "room-missing" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const [event] = await auditStore.list({ action: "nodes.channel-rooms.assign.failed" });

  assert.equal(response.status, 400);
  assert.equal(event?.reason, "room_not_found");
});

test("rejects an interface that is not on the node", async () => {
  const auditStore = createAuditStore("");
  const app = channelRoomApp({ auditStore, nodes: [sharedNode()], permissionCalls: [] });

  const response = await app.request(`/api/v1/nodes/${sharedNode().id}/channel-rooms`, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-elsewhere", roomId: "room-a" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const [event] = await auditStore.list({ action: "nodes.channel-rooms.assign.failed" });

  assert.equal(response.status, 400);
  assert.equal(event?.reason, "interface_not_found");
});

test("does not act on a node outside the caller's scope", async () => {
  const auditStore = createAuditStore("");
  const hidden = sharedNode({ id: "node-hidden" });
  const app = channelRoomApp({
    auditStore,
    nodes: [hidden],
    permissionCalls: [],
    scopedNodeIds: [],
  });

  const response = await app.request(`/api/v1/nodes/${hidden.id}/channel-rooms`, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: "room-a" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });

  assert.equal(response.status, 404);
});

test("denies callers without node:manage", async () => {
  const auditStore = createAuditStore("");
  const app = channelRoomApp({
    auditStore,
    nodes: [sharedNode()],
    permissionCalls: [],
    permissionMiddleware: denyMissingPermission(auditStore),
  });

  const response = await app.request(`/api/v1/nodes/${sharedNode().id}/channel-rooms`, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: "room-a" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const [denied] = await auditStore.list({ outcome: "denied" });

  assert.equal(response.status, 403);
  assert.equal(denied?.action, "nodes.channel-rooms.assign");
  assert.equal(denied?.reason, "missing_permission");
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditEvent["target"];
}

function channelRoomApp({
  auditStore,
  nodes,
  permissionCalls,
  permissionMiddleware,
  scopedNodeIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
  permissionMiddleware?: RequirePermission;
  scopedNodeIds?: string[];
}) {
  const app = new Hono<AppBindings>();

  registerChannelRoomRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore: createNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: permissionMiddleware ?? requirePermission(permissionCalls),
    roomStore: memoryRoomStore([room("room-a"), room("room-b")]),
    scopedNodes: async () =>
      nodes.filter(
        (candidate) => scopedNodeIds === undefined || scopedNodeIds.includes(candidate.id),
      ),
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    calls.push({ action, permission, target: target ? await target(c) : undefined });
    await next();
  };
}

function denyMissingPermission(auditStore: ReturnType<typeof createAuditStore>): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: auth(),
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_channel_room",
        name: "Channel Room User",
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

function memoryRoomStore(rooms: Room[]): RoomStore {
  return {
    async create() {
      throw new Error("not implemented");
    },
    async delete() {
      return undefined;
    },
    async find(roomId) {
      return rooms.find((candidate) => candidate.id === roomId);
    },
    async list() {
      return rooms;
    },
    async update() {
      return undefined;
    },
  };
}

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "channel-room@example.com",
    groups: [],
    id: "user_channel_room",
    name: "Channel Room User",
    permissions: ["node:manage"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function room(id: string): Room {
  return { id, name: id, site: "HQ" };
}

function sharedNode(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Shared Node",
    hostname: "shared-node",
    id: "node-shared",
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 4,
        channels: [
          { alias: "Ch 1", index: 1 },
          { alias: "Ch 2", index: 2 },
          { alias: "Ch 3", index: 3 },
          { alias: "Ch 4", index: 4 },
        ],
        id: "iface-1",
        sampleRates: [48000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Chamber", site: "HQ" },
    roomId: "room-default",
    status: "online",
    tags: [],
    ...input,
  };
}
