import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
  Room,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { RoomStore } from "../src/room-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-room-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("ad hoc recording is attributed to the selected channels' room", async () => {
  const recordingStore = memoryRecordingStore();
  const { app, nodeId } = recordingApp({ recordingStore });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureChannelSelection: [1, 2],
      captureInterfaceId: "iface-1",
      channelMode: "stereo",
      nodeId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { data: RecordingSummary };

  assert.equal(response.status, 202);
  assert.equal(body.data.roomId, "room-a");
  // Ad-hoc folder uses the capturing room's name, not the node install room.
  assert.match(body.data.folder, /Chamber A$/);
});

test("ad hoc recording rejects a channel selection spanning rooms", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const { app, nodeId } = recordingApp({ auditStore, recordingStore });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureChannelSelection: [1, 3],
      captureInterfaceId: "iface-1",
      channelMode: "stereo",
      nodeId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { reason: string };
  const recordings = await recordingStore.list();

  assert.equal(response.status, 400);
  assert.equal(body.reason, "channel_selection_cross_room");
  assert.equal(recordings.length, 0);
});

test("ad hoc recording is denied when the caller lacks the channel room", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  // Caller may create in room-a only; selecting room-b's channels must be denied.
  const { app, nodeId } = recordingApp({
    auditStore,
    authorizeTarget: async (_user, _permission, target) => target.id === "room-a",
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureChannelSelection: [3],
      captureInterfaceId: "iface-1",
      channelMode: "mono",
      nodeId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recordings.start.failed" });
  const recordings = await recordingStore.list();

  assert.equal(response.status, 403);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.target.id, "room-b");
  assert.equal(event?.target.type, "room");
  assert.equal(recordings.length, 0);
});

test("two rooms record disjoint channels on one shared node", async () => {
  const recordingStore = memoryRecordingStore();
  const { app, nodeId } = recordingApp({ recordingStore });

  const roomA = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureChannelSelection: [1],
      captureInterfaceId: "iface-1",
      channelMode: "mono",
      nodeId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const roomB = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureChannelSelection: [3],
      captureInterfaceId: "iface-1",
      channelMode: "mono",
      nodeId,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const bodyA = (await roomA.json()) as { data: RecordingSummary };
  const bodyB = (await roomB.json()) as { data: RecordingSummary };

  assert.equal(roomA.status, 202);
  assert.equal(roomB.status, 202);
  assert.equal(bodyA.data.roomId, "room-a");
  assert.equal(bodyB.data.roomId, "room-b");
  assert.equal((await recordingStore.list()).length, 2);
});

function recordingApp({
  auditStore = createAuditStore(""),
  authorizeTarget = async () => true,
  recordingStore,
}: {
  auditStore?: ReturnType<typeof createAuditStore>;
  authorizeTarget?: (
    user: CurrentUser,
    permission: Permission,
    target: AuditTarget,
  ) => Promise<boolean>;
  recordingStore: RecordingStore;
}) {
  const app = new Hono<AppBindings>();
  // A unique node id per app isolates the shared on-disk job store between tests.
  const nodeId = `node-shared-${randomUUID()}`;
  const nodes = [sharedNode(nodeId)];

  registerRecordingRoutes({
    app,
    authorizeTarget,
    currentAuth: () => auth(),
    currentUser: () => user(),
    hasResourceScope: async () => true,
    nodeStore: createNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: () => async (_c, next) => {
      await next();
    },
    roomStore: memoryRoomStore([room("room-a", "Chamber A"), room("room-b", "Chamber B")]),
    scopedNodes: async () => nodes,
    scopedRecordings: async () => recordingStore.list(),
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
  });

  return { app, nodeId };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: { id: "user_room", name: "Room User", roles: ["operator"], type: "user" },
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

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete() {
      return undefined;
    },
    async find(recordingId) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
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

function memorySettingsStore(profiles: RecordingProfile[]): SettingsStore {
  return {
    async assignChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async createChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async findChannelMapTemplate() {
      return undefined;
    },
    async findRecordingProfile(profileId) {
      return profiles.find((profile) => profile.id === profileId);
    },
    async findWatchdogPolicy() {
      return undefined;
    },
    async listChannelMapAssignments() {
      return [];
    },
    async listChannelMapTemplates() {
      return [];
    },
    async listRecordingProfiles() {
      return profiles;
    },
    async listWatchdogPolicies() {
      return [];
    },
    async rollbackChannelMapAssignment() {
      return undefined;
    },
    async updateChannelMapTemplate() {
      return undefined;
    },
    async updateRecordingProfile() {
      return undefined;
    },
    async updateWatchdogPolicy() {
      return undefined;
    },
  };
}

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "room@example.com",
    groups: [],
    id: "user_room",
    name: "Room User",
    permissions: ["recording:create"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function room(id: string, name: string): Room {
  return { id, name, site: "HQ" };
}

function sharedNode(id: string): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Shared Node",
    hostname: "shared-node",
    id,
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
