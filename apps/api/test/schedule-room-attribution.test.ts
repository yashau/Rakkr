import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "../src/http-types.js";
import type { ScheduleStore } from "../src/schedule-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-schedule-room-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { registerScheduleRoutes } = await import("../src/schedule-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("schedule update repointed onto another room's channels is denied", async () => {
  const auditStore = createAuditStore("");
  // Caller holds authority in room-a only (a room-a booker). Moving the schedule
  // to room-b's channels on the shared node must be denied.
  const store = scheduleStore([roomASchedule()]);
  const { app } = scheduleApp({
    auditStore,
    authorizeTarget: async (_user, _permission, target) => target.id === "room-a",
    store,
  });

  const response = await app.request("/api/v1/schedules/sched_room_a", {
    body: JSON.stringify({ captureChannelSelection: [3], channelMode: "mono" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const [denied] = await auditStore.list({ action: "schedules.update.failed" });
  const persisted = await store.find("sched_room_a");

  assert.equal(response.status, 403);
  assert.equal(denied?.outcome, "denied");
  assert.equal(denied?.target.id, "room-b");
  assert.equal(denied?.target.type, "room");
  // The schedule is unchanged — still room-a's channel.
  assert.equal(persisted?.roomId, "room-a");
  assert.deepEqual(persisted?.captureChannelSelection, [1]);
});

test("schedule update onto another room succeeds when the caller holds that room", async () => {
  const store = scheduleStore([roomASchedule()]);
  const { app } = scheduleApp({
    // Authorized in every room (e.g. an operator rostered in both, or an admin).
    authorizeTarget: async () => true,
    store,
  });

  const response = await app.request("/api/v1/schedules/sched_room_a", {
    body: JSON.stringify({ captureChannelSelection: [3], channelMode: "mono" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: ScheduleSummary };

  assert.equal(response.status, 200);
  assert.equal(body.data.roomId, "room-b");
});

test("schedule update within the same room does not require new-room authority", async () => {
  const store = scheduleStore([roomASchedule()]);
  // authorizeTarget denies everything: a same-room edit (no channel change) must
  // still succeed because the PATCH gate already proved the current room.
  const { app } = scheduleApp({ authorizeTarget: async () => false, store });

  const response = await app.request("/api/v1/schedules/sched_room_a", {
    body: JSON.stringify({ name: "Renamed" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: ScheduleSummary };

  assert.equal(response.status, 200);
  assert.equal(body.data.name, "Renamed");
  assert.equal(body.data.roomId, "room-a");
});

test("schedule update onto room-less channels is denied without node authority", async () => {
  const auditStore = createAuditStore("");
  // Room-less node: channel 1 belongs to room-a, channel 2 is unassigned. A room-A
  // booker (roster grants authorizeTarget, but hasResourceScope=false — no node
  // role/grant) tries to repoint the schedule onto the unowned channel 2.
  const store = scheduleStore([roomASchedule()]);
  const { app } = scheduleApp({
    auditStore,
    authorizeTarget: async () => true,
    hasResourceScope: async () => false,
    node: roomlessNode(),
    store,
  });

  const response = await app.request("/api/v1/schedules/sched_room_a", {
    body: JSON.stringify({ captureChannelSelection: [2], channelMode: "mono" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const [denied] = await auditStore.list({ action: "schedules.update.failed" });
  const persisted = await store.find("sched_room_a");

  assert.equal(response.status, 403);
  assert.equal(denied?.outcome, "denied");
  assert.equal(denied?.target.type, "node");
  // Unchanged — still room-a's channel 1.
  assert.equal(persisted?.roomId, "room-a");
  assert.deepEqual(persisted?.captureChannelSelection, [1]);
});

test("schedule update onto room-less channels succeeds with node authority", async () => {
  const store = scheduleStore([roomASchedule()]);
  const { app } = scheduleApp({
    authorizeTarget: async () => true,
    hasResourceScope: async () => true,
    node: roomlessNode(),
    store,
  });

  const response = await app.request("/api/v1/schedules/sched_room_a", {
    body: JSON.stringify({ captureChannelSelection: [2], channelMode: "mono" }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: ScheduleSummary };

  assert.equal(response.status, 200);
  assert.equal(body.data.roomId, undefined);
});

function scheduleApp({
  auditStore = createAuditStore(""),
  authorizeTarget = async () => true,
  hasResourceScope = async () => true,
  node = sharedNode(),
  store,
}: {
  auditStore?: ReturnType<typeof createAuditStore>;
  authorizeTarget?: (
    user: CurrentUser,
    permission: Permission,
    target: AuditTarget,
  ) => Promise<boolean>;
  hasResourceScope?: (user: CurrentUser, target: AuditTarget) => Promise<boolean>;
  node?: RecorderNode;
  store: ScheduleStore;
}) {
  const app = new Hono<AppBindings>();
  const nodes = [node];

  registerScheduleRoutes({
    app,
    authorizeTarget,
    currentAuth: () => auth(),
    currentUser: () => bookerUser(),
    hasResourceScope,
    nodeStore: createNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    // The PATCH gate passes: the caller is a legitimate booker in the schedule's
    // current room. The per-room re-check is what must guard the new room.
    requirePermission: () => async (_c, next) => {
      await next();
    },
    scheduleStore: store,
    scopedNodes: async () => nodes,
    scopedSchedules: async () => store.list(),
    settingsStore: createSettingsStore(),
  });

  return { app };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: { id: "user_booker", name: "Booker", roles: ["operator"], type: "user" },
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

function scheduleStore(schedules: ScheduleSummary[]): ScheduleStore {
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

function recordingStore() {
  const recordings: RecordingSummary[] = [];

  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
    async delete() {
      return undefined;
    },
    async find(recordingId: string) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
  };
}

function auth(): AuthResult {
  return { user: bookerUser() };
}

function bookerUser(): CurrentUser {
  return {
    email: "booker@example.com",
    groups: [],
    id: "user_booker",
    name: "Booker",
    permissions: ["schedule:manage", "schedule:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function roomASchedule(): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    captureChannelSelection: [1],
    captureInterfaceId: "iface-1",
    channelMode: "mono",
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id: "sched_room_a",
    name: "Room A Meeting",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: "node-shared",
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    roomId: "room-a",
    tags: ["council"],
    timezone: "UTC",
    titleTemplate: "{{date}} Room A Meeting",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
  };
}

// Room-less node (no default room): channel 1 → room-a, channel 2 unassigned. A
// selection of [2] resolves to no room, so updateRoom.roomId is undefined.
function roomlessNode(): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Roomless Node",
    hostname: "roomless-node",
    id: "node-shared",
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
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Install Rack", site: "HQ" },
    status: "online",
    tags: [],
  };
}

function sharedNode(): RecorderNode {
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
          { alias: "Ch 1", index: 1, roomId: "room-a" },
          { alias: "Ch 2", index: 2, roomId: "room-a" },
          { alias: "Ch 3", index: 3, roomId: "room-b" },
          { alias: "Ch 4", index: 4, roomId: "room-b" },
        ],
        id: "iface-1",
        sampleRates: [48000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Install Rack", site: "HQ" },
    status: "online",
    tags: [],
  };
}
