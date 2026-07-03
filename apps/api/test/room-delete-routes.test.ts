import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import type { RoomStore } from "../src/room-store.js";
import type { ScheduleStore } from "../src/schedule-store.js";

process.env.DATABASE_URL = "";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRoomRoutes } = await import("../src/room-routes.js");
const { DatabaseUnavailableError } = await import("../src/database-unavailable.js");

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

function roomApp({
  auditStore = createAuditStore(""),
  deleteError,
  removedRooms = [],
  rooms,
  schedules,
}: {
  auditStore?: ReturnType<typeof createAuditStore>;
  deleteError?: Error;
  removedRooms?: string[];
  rooms: Room[];
  schedules: ScheduleSummary[];
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
    listGroups: async () => [],
    listUsers: async () => [],
    nodeStore: {
      async list() {
        return [] as RecorderNode[];
      },
    } as never,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: {
      async list() {
        return [] as RecordingSummary[];
      },
    } as never,
    requirePermission: () => async (_c, next) => {
      await next();
    },
    roomRosterStore: {
      async removeForRoom(roomId: string) {
        removedRooms.push(roomId);
      },
    } as never,
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

function scheduleFor(roomId: string): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id: "sched_ref",
    name: "Referencing Schedule",
    nextRunAt: "2026-06-18T09:00:00.000Z",
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
