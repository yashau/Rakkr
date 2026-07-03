import type { Context, Hono } from "hono";
import { z } from "zod";
import type { RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { RoomStore } from "./room-store.js";
import { NodeStoreError, type ChannelRoomAssignment, type NodeStore } from "./node-store.js";

interface ChannelRoomRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeStore: NodeStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  roomStore: RoomStore;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
}

const channelRoomAssignmentSchema = z
  .object({
    channelIndexes: z.array(z.coerce.number().int().positive().max(512)).min(1).max(512),
    interfaceId: z.string().trim().min(1).max(160),
    // null clears the channel's room (it falls back to the node default).
    roomId: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();
const channelRoomAssignmentsSchema = z
  .object({
    assignments: z.array(channelRoomAssignmentSchema).min(1).max(256),
  })
  .strict();

// Operator action that partitions a recorder node's channels across rooms. Room
// ownership lives on channels, so this is `node:manage`-gated (the same authority
// that sets the node default room) and scoped to nodes the caller can see.
export function registerChannelRoomRoutes({
  app,
  currentAuth,
  currentUser,
  nodeStore,
  recordAuditEvent,
  requirePermission,
  roomStore,
  scopedNodes,
}: ChannelRoomRouteDependencies) {
  app.put(
    "/api/v1/nodes/:nodeId/channel-rooms",
    requirePermission("node:manage", "nodes.channel-rooms.assign", (c) => ({
      id: c.req.param("nodeId"),
      type: "node",
    })),
    async (c) => {
      const nodeId = c.req.param("nodeId");
      const body = channelRoomAssignmentsSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordFailure(c, "invalid_request", nodeId);
        return c.json({ error: "Invalid channel room assignment", issues: body.error.issues }, 400);
      }

      const before = (await scopedNodes(currentUser(c))).find((node) => node.id === nodeId);

      if (!before) {
        await recordFailure(c, "node_not_found", nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

      const requestedRoomIds = [
        ...new Set(
          body.data.assignments
            .map((assignment) => assignment.roomId)
            .filter((roomId): roomId is string => roomId !== null),
        ),
      ];
      const missingRoomId = await firstMissingRoom(roomStore, requestedRoomIds);

      if (missingRoomId) {
        await recordFailure(c, "room_not_found", before.alias, nodeId);
        return c.json({ error: `Room ${missingRoomId} not found` }, 400);
      }

      const flattened = flattenAssignments(body.data.assignments);

      const updated = await nodeStore
        .assignChannelRooms(nodeId, flattened)
        .catch(async (error: unknown) => {
          const reason =
            error instanceof NodeStoreError ? error.code : "channel_room_assign_failed";

          await recordFailure(c, reason, before.alias, nodeId);
          return {
            failureStatus: reason === "database_unavailable" ? (503 as const) : (400 as const),
          };
        });

      if (updated && "failureStatus" in updated) {
        return c.json(
          {
            error:
              updated.failureStatus === 503
                ? "Channel room assignment unavailable"
                : "Invalid channel room assignment",
          },
          updated.failureStatus,
        );
      }

      if (!updated) {
        await recordFailure(c, "node_not_found", before.alias, nodeId);
        return c.json({ error: "Node not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "nodes.channel-rooms.assign.succeeded",
        after: { channelRooms: channelRoomSnapshot(updated) },
        auth: currentAuth(c),
        before: { channelRooms: channelRoomSnapshot(before) },
        details: {
          assignedRoomIds: requestedRoomIds,
          channelCount: flattened.length,
        },
        outcome: "succeeded",
        permission: "node:manage",
        target: { id: updated.id, name: updated.alias, type: "node" },
      });

      return c.json({ data: updated });
    },
  );

  async function recordFailure(
    c: Context<AppBindings>,
    reason: string,
    name: string,
    targetId?: string,
  ) {
    await recordAuditEvent(c, {
      action: "nodes.channel-rooms.assign.failed",
      auth: currentAuth(c),
      outcome: "failed",
      permission: "node:manage",
      reason,
      target: { id: targetId, name, type: "node" },
    });
  }
}

function flattenAssignments(
  assignments: z.infer<typeof channelRoomAssignmentsSchema>["assignments"],
): ChannelRoomAssignment[] {
  return assignments.flatMap((assignment) =>
    assignment.channelIndexes.map((channelIndex) => ({
      channelIndex,
      interfaceId: assignment.interfaceId,
      roomId: assignment.roomId,
    })),
  );
}

async function firstMissingRoom(roomStore: RoomStore, roomIds: string[]) {
  for (const roomId of roomIds) {
    if (!(await roomStore.find(roomId))) {
      return roomId;
    }
  }

  return undefined;
}

// Compact audit snapshot: only channels that carry an explicit room.
function channelRoomSnapshot(node: RecorderNode) {
  return node.interfaces.flatMap((audioInterface) =>
    audioInterface.channels
      .filter((channel) => channel.roomId)
      .map((channel) => ({
        channelIndex: channel.index,
        interfaceId: audioInterface.id,
        roomId: channel.roomId,
      })),
  );
}
