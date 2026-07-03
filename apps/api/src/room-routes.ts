import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  roomInputSchema,
  roomRosterUpdateSchema,
  roomUpdateSchema,
  type RecorderNode,
  type RecordingSummary,
  type Room,
  type RoomOverview,
  type RoomRosterEntry,
  type RoomUpcomingOccurrence,
  type ScheduleSummary,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { isDatabaseUnavailableError } from "./database-unavailable.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import { nodeRoomIds } from "./room-resolution.js";
import type { RecordingStore } from "./recording-store.js";
import { previewScheduleOccurrences } from "./schedule-engine.js";
import type { ScheduleStore } from "./schedule-store.js";
import { RoomStoreError, type RoomStore } from "./room-store.js";
import type { RoomRosterStore } from "./room-roster-store.js";

export interface RoomRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  listGroups: () => Promise<Array<{ id: string; name: string }>>;
  listUsers: () => Promise<Array<{ id: string; name: string }>>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  roomRosterStore: RoomRosterStore;
  roomStore: RoomStore;
  scheduleStore: ScheduleStore;
  scheduledByName: (scheduleId: string) => Promise<string | undefined>;
  scopedRooms: (user: NonNullable<AuthResult["user"]>) => Promise<Room[]>;
}

const ROOM_COLLECTION_TARGET: AuditTarget = {
  id: "room_collection",
  type: "room_collection",
};

const UPCOMING_LOOKAHEAD = 3;
const UPCOMING_LIMIT = 10;
const RECENT_RECORDINGS_LIMIT = 10;

export function registerRoomRoutes({
  app,
  currentAuth,
  currentUser,
  listGroups,
  listUsers,
  nodeStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  roomRosterStore,
  roomStore,
  scheduleStore,
  scheduledByName,
  scopedRooms,
}: RoomRouteDependencies) {
  app.get(
    "/api/v1/rooms",
    requirePermission("node:read", "rooms.read", () => ROOM_COLLECTION_TARGET),
    async (c) => {
      const rooms = await scopedRooms(currentUser(c));
      const nodes = await nodeStore.list();
      const data = rooms.map((room) => withNodeCount(room, nodes));

      await recordAuditEvent(c, {
        action: "rooms.read.succeeded",
        auth: currentAuth(c),
        details: {
          returnedCount: data.length,
        },
        outcome: "succeeded",
        permission: "node:read",
        target: ROOM_COLLECTION_TARGET,
      });

      return c.json({ data });
    },
  );

  app.post(
    "/api/v1/rooms",
    requirePermission("node:manage", "rooms.create", () => ROOM_COLLECTION_TARGET),
    async (c) => {
      const body = roomInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordRoomCollectionFailure(
          c,
          "rooms.create.failed",
          "node:manage",
          "invalid_request",
        );
        return c.json({ error: "Invalid room", issues: body.error.issues }, 400);
      }

      const room: Room = {
        ...body.data,
        id: body.data.id ?? `room_${randomUUID()}`,
      };

      try {
        const created = await roomStore.create(room);

        await recordAuditEvent(c, {
          action: "rooms.create.succeeded",
          after: created,
          auth: currentAuth(c),
          outcome: "succeeded",
          permission: "node:manage",
          target: {
            id: created.id,
            name: created.name,
            type: "room",
          },
        });

        return c.json({ data: created }, 201);
      } catch (error) {
        const reason = error instanceof RoomStoreError ? error.code : "room_create_failed";

        await recordRoomCollectionFailure(c, "rooms.create.failed", "node:manage", reason);
        return c.json(
          { error: "Room could not be created", reason },
          reason === "room_exists" ? 409 : 503,
        );
      }
    },
  );

  app.get(
    "/api/v1/rooms/:roomId",
    requirePermission("node:read", "rooms.detail.read", (c) => roomTarget(c)),
    async (c) => {
      const roomId = c.req.param("roomId");
      const room = await roomStore.find(roomId);

      if (!room) {
        await recordRoomFailure(
          c,
          "rooms.detail.read.failed",
          "node:read",
          "room_not_found",
          roomId,
        );
        return c.json({ error: "Room not found" }, 404);
      }

      const data = withNodeCount(room, await nodeStore.list());

      await recordAuditEvent(c, {
        action: "rooms.detail.read.succeeded",
        auth: currentAuth(c),
        details: {
          nodeCount: data.nodeCount,
        },
        outcome: "succeeded",
        permission: "node:read",
        target: {
          id: room.id,
          name: room.name,
          type: "room",
        },
      });

      return c.json({ data });
    },
  );

  app.patch(
    "/api/v1/rooms/:roomId",
    requirePermission("node:manage", "rooms.update", (c) => roomTarget(c)),
    async (c) => {
      const roomId = c.req.param("roomId");
      const before = await roomStore.find(roomId);

      if (!before) {
        await recordRoomFailure(c, "rooms.update.failed", "node:manage", "room_not_found", roomId);
        return c.json({ error: "Room not found" }, 404);
      }

      const body = roomUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordRoomFailure(
          c,
          "rooms.update.failed",
          "node:manage",
          "invalid_request",
          roomId,
          before.name,
        );
        return c.json({ error: "Invalid room update", issues: body.error.issues }, 400);
      }

      const updated = await roomStore.update(roomId, body.data);

      if (!updated) {
        await recordRoomFailure(
          c,
          "rooms.update.failed",
          "node:manage",
          "room_not_found",
          roomId,
          before.name,
        );
        return c.json({ error: "Room not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "rooms.update.succeeded",
        after: updated,
        auth: currentAuth(c),
        before,
        outcome: "succeeded",
        permission: "node:manage",
        target: {
          id: updated.id,
          name: updated.name,
          type: "room",
        },
      });

      return c.json({ data: updated });
    },
  );

  app.delete(
    "/api/v1/rooms/:roomId",
    requirePermission("node:manage", "rooms.delete", (c) => roomTarget(c)),
    async (c) => {
      const roomId = c.req.param("roomId");
      const before = await roomStore.find(roomId);

      if (!before) {
        await recordRoomFailure(c, "rooms.delete.failed", "node:manage", "room_not_found", roomId);
        return c.json({ error: "Room not found" }, 404);
      }

      // A schedule references the room via schedules.roomId (RESTRICT in Postgres).
      // Enforce it in the route so BOTH the Postgres and JSON-fallback stores reject
      // uniformly — the JSON store has no FK, so relying on the store to throw let a
      // JSON-mode delete strand a dangling schedule.roomId.
      const referencingSchedule = (await scheduleStore.list()).some(
        (schedule) => schedule.roomId === roomId,
      );

      if (referencingSchedule) {
        await recordRoomFailure(
          c,
          "rooms.delete.failed",
          "node:manage",
          "room_in_use",
          roomId,
          before.name,
        );
        return c.json(
          { error: "Room is still referenced by schedules", reason: "room_in_use" },
          409,
        );
      }

      try {
        const deleted = await roomStore.delete(roomId);

        if (!deleted) {
          await recordRoomFailure(
            c,
            "rooms.delete.failed",
            "node:manage",
            "room_not_found",
            roomId,
            before.name,
          );
          return c.json({ error: "Room not found" }, 404);
        }

        // Cascade the roster cleanup explicitly so it is backend-independent (the
        // Postgres FK cascade covers the DB, but the JSON fallback would otherwise
        // orphan roster rows that a reused room slug could silently inherit).
        await roomRosterStore.removeForRoom(roomId);

        await recordAuditEvent(c, {
          action: "rooms.delete.succeeded",
          auth: currentAuth(c),
          before: deleted,
          outcome: "succeeded",
          permission: "node:manage",
          target: {
            id: deleted.id,
            name: deleted.name,
            type: "room",
          },
        });

        return c.body(null, 204);
      } catch (error) {
        // The schedule referential pre-check above is the real FK guard, so a store
        // error here is treated as a DB-availability problem: surface it as 503 via
        // the onError boundary rather than mislabeling it "room in use". NOTE: the
        // rare check→delete race (a schedule created between the pre-check and the
        // DELETE) trips the Postgres RESTRICT FK, which PostgresRoomStore wraps as
        // DatabaseUnavailableError, so it also 503s here and self-heals on the
        // client's retry (the pre-check then sees the schedule and returns 409). A
        // precise 409 for that race needs the store to detect SQLSTATE 23503 — see
        // the R3-FK-RACE ledger item. The 409 fallback below covers any other
        // (non-DB) store error defensively.
        if (isDatabaseUnavailableError(error)) {
          throw error;
        }

        await recordRoomFailure(
          c,
          "rooms.delete.failed",
          "node:manage",
          "room_in_use",
          roomId,
          before.name,
        );
        return c.json(
          { error: "Room is still referenced by schedules", reason: "room_in_use" },
          409,
        );
      }
    },
  );

  app.get(
    "/api/v1/rooms/:roomId/overview",
    requirePermission("node:read", "rooms.overview.read", (c) => roomTarget(c)),
    async (c) => {
      const roomId = c.req.param("roomId");
      const room = await roomStore.find(roomId);

      if (!room) {
        await recordRoomFailure(
          c,
          "rooms.overview.read.failed",
          "node:read",
          "room_not_found",
          roomId,
        );
        return c.json({ error: "Room not found" }, 404);
      }

      // A node belongs to the room if any of its channels do (a shared node
      // appears in every room it serves). Recent recordings use the recording's
      // persisted room, not the node, so a shared node shows only this room's.
      const nodes = (await nodeStore.list()).filter((node) => nodeRoomIds(node).has(roomId));
      const upcoming = await buildUpcomingOccurrences(roomId);
      const recentRecordings: RecordingSummary[] = (await recordingStore.list())
        .filter((recording) => recording.roomId === roomId)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
        .slice(0, RECENT_RECORDINGS_LIMIT);

      const overview: RoomOverview = {
        nodes,
        recentRecordings,
        room: { ...room, nodeCount: nodes.length },
        upcoming,
      };

      await recordAuditEvent(c, {
        action: "rooms.overview.read.succeeded",
        auth: currentAuth(c),
        details: {
          nodeCount: nodes.length,
          recentRecordingCount: recentRecordings.length,
          upcomingCount: upcoming.length,
        },
        outcome: "succeeded",
        permission: "node:read",
        target: {
          id: room.id,
          name: room.name,
          type: "room",
        },
      });

      return c.json({ data: overview });
    },
  );

  app.get(
    "/api/v1/rooms/:roomId/roster",
    requirePermission("auth:manage", "rooms.roster.read", (c) => roomTarget(c)),
    async (c) => {
      const roomId = c.req.param("roomId");
      const room = await roomStore.find(roomId);

      if (!room) {
        await recordRoomFailure(
          c,
          "rooms.roster.read.failed",
          "auth:manage",
          "room_not_found",
          roomId,
        );
        return c.json({ error: "Room not found" }, 404);
      }

      const data = await rosterWithNames(roomId);

      await recordAuditEvent(c, {
        action: "rooms.roster.read.succeeded",
        auth: currentAuth(c),
        details: {
          entryCount: data.length,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          id: room.id,
          name: room.name,
          type: "room",
        },
      });

      return c.json({ data });
    },
  );

  app.put(
    "/api/v1/rooms/:roomId/roster",
    requirePermission("auth:manage", "rooms.roster.update", (c) => roomTarget(c)),
    async (c) => {
      const roomId = c.req.param("roomId");
      const room = await roomStore.find(roomId);

      if (!room) {
        await recordRoomFailure(
          c,
          "rooms.roster.update.failed",
          "auth:manage",
          "room_not_found",
          roomId,
        );
        return c.json({ error: "Room not found" }, 404);
      }

      const body = roomRosterUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordRoomFailure(
          c,
          "rooms.roster.update.failed",
          "auth:manage",
          "invalid_request",
          roomId,
          room.name,
        );
        return c.json({ error: "Invalid roster update", issues: body.error.issues }, 400);
      }

      const before = await roomRosterStore.listForRoom(roomId);
      await roomRosterStore.replaceManual(roomId, body.data.entries, currentUser(c).id);
      const data = await rosterWithNames(roomId);

      await recordAuditEvent(c, {
        action: "rooms.roster.update.succeeded",
        after: { entryCount: data.length },
        auth: currentAuth(c),
        before: { entryCount: before.length },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          id: room.id,
          name: room.name,
          type: "room",
        },
      });

      return c.json({ data });
    },
  );

  function withNodeCount(room: Room, nodes: RecorderNode[]): Room {
    return {
      ...room,
      // Count nodes with ANY channel owned by this room (a shared node counts for
      // every room it serves).
      nodeCount: nodes.filter((node) => nodeRoomIds(node).has(room.id)).length,
    };
  }

  // Flattens the next few occurrences of every ENABLED schedule pinned to this
  // room, sorted by recording start and capped for the room-overview panel.
  async function buildUpcomingOccurrences(roomId: string): Promise<RoomUpcomingOccurrence[]> {
    const schedules: ScheduleSummary[] = (await scheduleStore.list()).filter(
      (schedule) => schedule.enabled && schedule.roomId === roomId,
    );
    const occurrences: RoomUpcomingOccurrence[] = [];

    for (const schedule of schedules) {
      const scheduledBy = await scheduledByName(schedule.id);

      for (const occurrence of previewScheduleOccurrences(schedule, UPCOMING_LOOKAHEAD)) {
        occurrences.push({
          ...(occurrence.recordingEndAt ? { recordingEndAt: occurrence.recordingEndAt } : {}),
          recordingStartAt: occurrence.recordingStartAt,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          ...(scheduledBy ? { scheduledByName: scheduledBy } : {}),
        });
      }
    }

    return occurrences
      .sort((a, b) => a.recordingStartAt.localeCompare(b.recordingStartAt))
      .slice(0, UPCOMING_LIMIT);
  }

  // Resolves each roster entry's subject to a display name via the user/group
  // directories, keyed by subjectType.
  async function rosterWithNames(roomId: string): Promise<RoomRosterEntry[]> {
    const entries = await roomRosterStore.listForRoom(roomId);
    const users = new Map((await listUsers()).map((user) => [user.id, user.name]));
    const groups = new Map((await listGroups()).map((group) => [group.id, group.name]));

    return entries.map((entry) => {
      const name =
        entry.subjectType === "group" ? groups.get(entry.subjectId) : users.get(entry.subjectId);

      return name ? { ...entry, subjectName: name } : entry;
    });
  }

  async function recordRoomCollectionFailure(
    c: Context<AppBindings>,
    action: string,
    permission: "node:manage" | "node:read",
    reason: string,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission,
      reason,
      target: ROOM_COLLECTION_TARGET,
    });
  }

  async function recordRoomFailure(
    c: Context<AppBindings>,
    action: string,
    permission: "auth:manage" | "node:manage" | "node:read",
    reason: string,
    roomId: string,
    name?: string,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission,
      reason,
      target: {
        id: roomId,
        name,
        type: "room",
      },
    });
  }
}

function roomTarget(c: Context<AppBindings>): AuditTarget {
  return {
    id: c.req.param("roomId"),
    type: "room",
  };
}
