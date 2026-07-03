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
  RecorderNode,
  RecordingSummary,
  Room,
  ScheduleSummary,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { RoomRosterStore } from "../src/room-roster-store.js";
import type { RoomStore } from "../src/room-store.js";
import type { ScheduleStore } from "../src/schedule-store.js";

const rosterStoreRoot = await mkdtemp(path.join(tmpdir(), "rakkr-room-routes-roster-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_ROOM_ROSTER_STORE_PATH = path.join(rosterStoreRoot, "room-roster.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRoomRoutes } = await import("../src/room-routes.js");
const { DatabaseUnavailableError } = await import("../src/database-unavailable.js");
const { createRoomRosterStore } = await import("../src/room-roster-store.js");

test.after(async () => {
  await rm(rosterStoreRoot, { force: true, recursive: true });
});

test("deleting a room referenced by a schedule is rejected 409, room + schedule intact", async () => {
  const auditStore = createAuditStore("");
  const removedRooms: string[] = [];
  const rooms = [room("room-a")];
  const { app } = roomApp({
    auditStore,
    removedRooms,
    rooms,
    schedules: [scheduleFor("room-a")],
  });

  const response = await app.request("/api/v1/rooms/room-a", { method: "DELETE" });
  const body = (await response.json()) as { reason: string };
  const [failed] = await auditStore.list({ action: "rooms.delete.failed" });

  assert.equal(response.status, 409);
  assert.equal(body.reason, "room_in_use");
  assert.equal(failed?.reason, "room_in_use");
  // Room not deleted and roster cleanup not run.
  assert.equal(rooms.length, 1);
  assert.deepEqual(removedRooms, []);
});

test("deleting an unreferenced room succeeds 204 and cleans its roster", async () => {
  const rooms = [room("room-a")];
  const removedRooms: string[] = [];
  const { app } = roomApp({ removedRooms, rooms, schedules: [] });

  const response = await app.request("/api/v1/rooms/room-a", { method: "DELETE" });

  assert.equal(response.status, 204);
  assert.equal(rooms.length, 0);
  // Roster rows for the deleted room are explicitly cleaned (backend-independent).
  assert.deepEqual(removedRooms, ["room-a"]);
});

test("a DB outage during room delete surfaces as 503, not a false 409 room_in_use", async () => {
  const auditStore = createAuditStore("");
  const rooms = [room("room-a")];
  const { app } = roomApp({
    auditStore,
    deleteError: new DatabaseUnavailableError("db down"),
    rooms,
    schedules: [],
  });

  const response = await app.request("/api/v1/rooms/room-a", { method: "DELETE" });
  const failures = await auditStore.list({ action: "rooms.delete.failed" });

  assert.equal(response.status, 503);
  // Not misreported as room_in_use.
  assert.equal(failures.length, 0);
});

test("room overview isolates recordings and occurrences by room on a shared node", async () => {
  const rooms = [room("room-a"), room("room-b")];
  const { app } = roomApp({
    nodes: [sharedNode()],
    recordings: [recording("rec_a", "room-a"), recording("rec_b", "room-b")],
    rooms,
    schedules: [scheduleFor("room-a", "sched_a"), scheduleFor("room-b", "sched_b")],
  });

  const response = await app.request("/api/v1/rooms/room-a/overview");
  const { data } = (await response.json()) as {
    data: {
      nodes: RecorderNode[];
      recentRecordings: RecordingSummary[];
      upcoming: Array<{ scheduleId: string }>;
    };
  };

  assert.equal(response.status, 200);
  // The shared node serves both rooms, so it appears in room-a's overview.
  assert.deepEqual(
    data.nodes.map((node) => node.id),
    ["node_shared"],
  );
  // Recordings and occurrences are room-scoped: room-b's must not leak into room-a.
  assert.deepEqual(
    data.recentRecordings.map((r) => r.id),
    ["rec_a"],
    "only room-a recordings are shown",
  );
  assert.deepEqual(
    data.upcoming.map((occurrence) => occurrence.scheduleId),
    ["sched_a"],
    "only room-a occurrences are shown",
  );
});

test("roster PUT rejects an unknown room with 404 (room-scoped)", async () => {
  const auditStore = createAuditStore("");
  const { app } = roomApp({
    auditStore,
    roomRosterStore: createRoomRosterStore(),
    rooms: [room("room-a")],
    schedules: [],
  });

  const response = await app.request("/api/v1/rooms/room-ghost/roster", {
    body: JSON.stringify({ entries: [] }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  const [failed] = await auditStore.list({ action: "rooms.roster.update.failed" });

  assert.equal(response.status, 404);
  assert.equal(failed?.reason, "room_not_found");
});

test("roster PUT replaces manual entries for the target room and round-trips (bogus subject stays inert)", async () => {
  const rosterStore = createRoomRosterStore();
  const { app } = roomApp({
    groups: [{ id: "group_av", name: "AV Team" }],
    roomRosterStore: rosterStore,
    rooms: [room("room-a"), room("room-b")],
    schedules: [],
    users: [{ id: "user_op", name: "Operator" }],
  });

  const putResponse = await app.request("/api/v1/rooms/room-a/roster", {
    body: JSON.stringify({
      entries: [
        { capabilities: ["view", "operate"], subjectId: "user_op", subjectType: "user" },
        // A subject that matches no user/group: the route does not reject it, it is
        // stored as an inert row (documents the fail-inert contract).
        { capabilities: ["view"], subjectId: "group_ghost", subjectType: "group" },
      ],
    }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  const putBody = (await putResponse.json()) as {
    data: Array<{ capabilities: string[]; subjectId: string; subjectType: string }>;
  };

  assert.equal(putResponse.status, 200);
  assert.deepEqual(
    putBody.data.map((entry) => entry.subjectId).sort(),
    ["group_ghost", "user_op"],
    "both the real and the inert subject are stored",
  );

  // The write is scoped to room-a only: room-b's roster is untouched.
  const roomBGet = await app.request("/api/v1/rooms/room-b/roster");
  const roomBBody = (await roomBGet.json()) as { data: unknown[] };
  assert.deepEqual(roomBBody.data, [], "the PUT did not touch a sibling room's roster");

  // And the persisted room-a roster round-trips through GET.
  const roomAGet = await app.request("/api/v1/rooms/room-a/roster");
  const roomABody = (await roomAGet.json()) as { data: Array<{ subjectId: string }> };
  assert.deepEqual(roomABody.data.map((entry) => entry.subjectId).sort(), [
    "group_ghost",
    "user_op",
  ]);
});

function roomApp({
  auditStore = createAuditStore(""),
  deleteError,
  groups = [],
  nodes = [],
  recordings = [],
  removedRooms = [],
  rooms,
  roomRosterStore: providedRosterStore,
  schedules,
  users = [],
}: {
  auditStore?: ReturnType<typeof createAuditStore>;
  deleteError?: Error;
  groups?: Array<{ id: string; name: string }>;
  nodes?: RecorderNode[];
  recordings?: RecordingSummary[];
  removedRooms?: string[];
  rooms: Room[];
  roomRosterStore?: RoomRosterStore;
  schedules: ScheduleSummary[];
  users?: Array<{ id: string; name: string }>;
}) {
  const app = new Hono<AppBindings>();
  // Mirror the production onError mapping so a rethrown DatabaseUnavailableError
  // becomes 503 rather than a generic 500.
  app.onError((error, c) => {
    if (error instanceof DatabaseUnavailableError) {
      return c.json({ error: "Database unavailable", reason: "database_unavailable" }, 503);
    }

    return c.json({ error: "Internal error" }, 500);
  });

  registerRoomRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    listGroups: async () => groups,
    listUsers: async () => users,
    nodeStore: {
      async list() {
        return nodes;
      },
    } as never,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: {
      async list() {
        return recordings;
      },
    } as never,
    requirePermission: () => async (_c, next) => {
      await next();
    },
    roomRosterStore:
      providedRosterStore ??
      ({
        async removeForRoom(roomId: string) {
          removedRooms.push(roomId);
        },
      } as never),
    roomStore: roomStore(rooms, deleteError),
    scheduleStore: scheduleStore(schedules),
    scheduledByName: async () => undefined,
    scopedRooms: async () => rooms,
  });

  return { app };
}

function roomStore(rooms: Room[], deleteError?: Error): RoomStore {
  return {
    async create(room) {
      rooms.push(room);
      return room;
    },
    async delete(roomId) {
      if (deleteError) {
        throw deleteError;
      }

      const index = rooms.findIndex((candidate) => candidate.id === roomId);
      const [deleted] = index >= 0 ? rooms.splice(index, 1) : [];
      return deleted;
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

function scheduleStore(schedules: ScheduleSummary[]): ScheduleStore {
  return {
    async create(schedule) {
      schedules.unshift(schedule);
      return schedule;
    },
    async delete() {
      return undefined;
    },
    async find(scheduleId) {
      return schedules.find((candidate) => candidate.id === scheduleId);
    },
    async list() {
      return schedules;
    },
    async update() {
      return undefined;
    },
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: { id: "user_admin", name: "Admin", roles: ["admin"], type: "user" },
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

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "admin@example.com",
    groups: [],
    id: "user_admin",
    name: "Admin",
    permissions: ["node:manage"],
    provider: "local",
    resourceGrants: [{ resourceId: "*", resourceType: "*" }],
    roles: ["admin"],
  };
}

function room(id: string): Room {
  return { id, name: id, site: "HQ" };
}

function scheduleFor(roomId: string, id = "sched_ref"): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id,
    name: `${id} for ${roomId}`,
    nextRunAt: "2026-08-01T09:00:00.000Z",
    nodeId: "node-x",
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    roomId,
    tags: [],
    timezone: "UTC",
    titleTemplate: "{{date}} Referencing Schedule",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
  };
}

// A shared node whose interface has one channel in each room, so it belongs to
// (appears in) both rooms' overviews.
function sharedNode(): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Shared Rig",
    hostname: "shared-rig",
    id: "node_shared",
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 2,
        channels: [
          { alias: "A", index: 1, roomId: "room-a" },
          { alias: "B", index: 2, roomId: "room-b" },
        ],
        id: "if1",
        sampleRates: [48_000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Rack", site: "HQ" },
    status: "online",
    tags: [],
  };
}

function recording(id: string, roomId: string): RecordingSummary {
  return {
    cached: true,
    durationSeconds: 60,
    folder: "meetings/2026-06-18",
    healthStatus: "healthy",
    id,
    name: `${id} in ${roomId}`,
    nodeId: "node_shared",
    recordedAt: "2026-06-18T09:00:00.000Z",
    roomId,
    source: "schedule",
    status: "completed",
    tags: [],
  };
}
