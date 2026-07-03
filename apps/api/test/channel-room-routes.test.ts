import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  Room,
  ScheduleSummary,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { RoomStore } from "../src/room-store.js";
import type { ScheduleStore } from "../src/schedule-store.js";

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

test("reassigning a channel re-homes the schedules that captured it", async () => {
  const auditStore = createAuditStore("");
  const reconciledRosters: ScheduleSummary[] = [];
  // Node channel 1 currently belongs to room-a; a schedule captures it (roomId room-a).
  const node = sharedNode({
    roomId: undefined,
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 4,
        channels: [
          { alias: "Ch 1", index: 1, roomId: "room-a" },
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
  });
  const scheduleStore = memoryScheduleStore([roomScheduleFixture()]);
  const app = channelRoomApp({
    auditStore,
    nodes: [node],
    permissionCalls: [],
    reconciledRosters,
    scheduleStore,
  });

  const response = await app.request(`/api/v1/nodes/${node.id}/channel-rooms`, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: "room-b" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const [event] = await auditStore.list({ action: "nodes.channel-rooms.assign.succeeded" });
  const reconciled = await scheduleStore.find("sched_reconcile");

  assert.equal(response.status, 200);
  // The schedule follows the channel to room-b — no longer stranded in room-a.
  assert.equal(reconciled?.roomId, "room-b");
  // Its calendar roster was re-homed (reconcileScheduleRoster called with room-b).
  assert.deepEqual(
    reconciledRosters.map((schedule) => schedule.roomId),
    ["room-b"],
  );
  assert.deepEqual(event?.details.reassignedScheduleIds, ["sched_reconcile"]);
});

test("channel-room reconcile isolates a per-schedule failure and still reconciles the rest", async () => {
  const auditStore = createAuditStore("");
  const failing = roomScheduleFixture({ id: "sched_fail" });
  const healthy = roomScheduleFixture({ id: "sched_ok" });
  const base = memoryScheduleStore([failing, healthy]);
  // The first schedule's update throws mid-loop; the node channel-rooms are already
  // committed, so a non-atomic reconcile would abort and leave sched_ok stale.
  const scheduleStore: ScheduleStore = {
    ...base,
    async update(scheduleId, update) {
      if (scheduleId === "sched_fail") {
        throw new Error("simulated schedule update failure");
      }

      return base.update(scheduleId, update);
    },
  };
  const app = channelRoomApp({
    auditStore,
    nodes: [sharedNode()],
    permissionCalls: [],
    scheduleStore,
  });

  const response = await app.request("/api/v1/nodes/node-shared/channel-rooms", {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: "room-b" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const [event] = await auditStore.list({ action: "nodes.channel-rooms.assign.succeeded" });

  assert.equal(response.status, 200);
  // The healthy schedule still reconciled despite the other's failure...
  assert.equal((await scheduleStore.find("sched_ok"))?.roomId, "room-b");
  assert.deepEqual(event?.details.reassignedScheduleIds, ["sched_ok"]);
  // ...and the failure is surfaced in the audit trail.
  assert.deepEqual(event?.details.reconcileFailedScheduleIds, ["sched_fail"]);
});

test("a retry PUT re-runs a schedule roster reconcile that failed on the first pass", async () => {
  const auditStore = createAuditStore("");
  // Channel 1 belongs to room-a; a schedule captures it.
  const node = sharedNode({
    roomId: undefined,
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 4,
        channels: [
          { alias: "Ch 1", index: 1, roomId: "room-a" },
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
  });
  const scheduleStore = memoryScheduleStore([roomScheduleFixture()]);
  const reconciledRosters: ScheduleSummary[] = [];
  let rosterAttempts = 0;
  // The roster reconcile fails the first time (a transient store blip), then succeeds.
  const reconcileScheduleRoster = async (schedule: ScheduleSummary) => {
    rosterAttempts += 1;

    if (rosterAttempts === 1) {
      throw new Error("simulated roster reconcile failure");
    }

    reconciledRosters.push(schedule);
  };
  const app = channelRoomApp({
    auditStore,
    nodes: [node],
    permissionCalls: [],
    reconcileScheduleRoster,
    scheduleStore,
  });
  const body = JSON.stringify({
    assignments: [{ channelIndexes: [1], interfaceId: "iface-1", roomId: "room-b" }],
  });
  const request = () =>
    app.request(`/api/v1/nodes/${node.id}/channel-rooms`, {
      body,
      headers: { "content-type": "application/json" },
      method: "PUT",
    });

  // First PUT: the roster reconcile throws, so the schedule must NOT be committed to
  // room-b (roomId is the commit point) — otherwise a retry would see it already at
  // room-b and skip it, stranding the roster forever.
  const first = await request();
  assert.equal(first.status, 200);
  assert.equal(
    (await scheduleStore.find("sched_reconcile"))?.roomId,
    "room-a",
    "a failed roster reconcile must not leave the schedule committed to the new room",
  );

  // Second PUT: re-detects the pending move and re-runs the roster reconcile, which
  // now succeeds — the schedule and its roster both land in room-b.
  const second = await request();
  assert.equal(second.status, 200);
  assert.equal((await scheduleStore.find("sched_reconcile"))?.roomId, "room-b");
  assert.deepEqual(
    reconciledRosters.map((schedule) => schedule.roomId),
    ["room-b"],
    "the retry re-ran the roster reconcile into room-b",
  );
});

test("reassigning a channel that splits a schedule across rooms makes it room-less", async () => {
  const auditStore = createAuditStore("");
  const node = sharedNode({
    roomId: undefined,
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 4,
        channels: [
          { alias: "Ch 1", index: 1, roomId: "room-a" },
          { alias: "Ch 2", index: 2, roomId: "room-a" },
          { alias: "Ch 3", index: 3 },
          { alias: "Ch 4", index: 4 },
        ],
        id: "iface-1",
        sampleRates: [48000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
  });
  // Schedule captures channels 1 and 2, both room-a today.
  const scheduleStore = memoryScheduleStore([
    roomScheduleFixture({ captureChannelSelection: [1, 2], channelMode: "stereo" }),
  ]);
  const app = channelRoomApp({ auditStore, nodes: [node], permissionCalls: [], scheduleStore });

  // Move channel 2 to room-b — the schedule now spans two rooms.
  const response = await app.request(`/api/v1/nodes/${node.id}/channel-rooms`, {
    body: JSON.stringify({
      assignments: [{ channelIndexes: [2], interfaceId: "iface-1", roomId: "room-b" }],
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  const reconciled = await scheduleStore.find("sched_reconcile");

  assert.equal(response.status, 200);
  // No single room owns the selection, so the schedule is left room-less (the run
  // path then defers it) rather than silently retaining the stale room-a.
  assert.equal(reconciled?.roomId, undefined);
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
  reconcileScheduleRoster,
  reconciledRosters,
  scheduleStore = memoryScheduleStore([]),
  scopedNodeIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
  permissionMiddleware?: RequirePermission;
  reconcileScheduleRoster?: (schedule: ScheduleSummary) => Promise<void>;
  reconciledRosters?: ScheduleSummary[];
  scheduleStore?: ScheduleStore;
  scopedNodeIds?: string[];
}) {
  const app = new Hono<AppBindings>();

  registerChannelRoomRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore: createNodeStore(nodes),
    reconcileScheduleRoster:
      reconcileScheduleRoster ??
      (async (schedule) => {
        reconciledRosters?.push(schedule);
      }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: permissionMiddleware ?? requirePermission(permissionCalls),
    roomStore: memoryRoomStore([room("room-a"), room("room-b")]),
    scheduleStore,
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

function memoryScheduleStore(schedules: ScheduleSummary[]): ScheduleStore {
  return {
    async create(schedule) {
      schedules.unshift(schedule);
      return schedule;
    },
    async delete(scheduleId) {
      const index = schedules.findIndex((candidate) => candidate.id === scheduleId);
      const [deleted] = index >= 0 ? schedules.splice(index, 1) : [];
      return deleted;
    },
    async find(scheduleId) {
      return schedules.find((candidate) => candidate.id === scheduleId);
    },
    async list() {
      return schedules;
    },
    async update(scheduleId, update) {
      const index = schedules.findIndex((candidate) => candidate.id === scheduleId);

      if (index < 0) {
        return undefined;
      }

      schedules[index] = { ...schedules[index], ...update };

      return schedules[index];
    },
  };
}

function roomScheduleFixture(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: ["user_assignee"],
    captureChannelSelection: [1],
    captureInterfaceId: "iface-1",
    channelMode: "mono",
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id: "sched_reconcile",
    name: "Reconcile Meeting",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: "node-shared",
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    roomId: "room-a",
    tags: [],
    timezone: "UTC",
    titleTemplate: "{{date}} Reconcile Meeting",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...input,
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
