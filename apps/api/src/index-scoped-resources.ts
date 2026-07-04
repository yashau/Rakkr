// Per-user resource visibility helpers, extracted from index.ts to keep the API
// composition root within the LOC budget. These closures decide which nodes,
// schedules, rooms, and recordings a caller may see, plus the per-room meter /
// monitor access decisions. They are pure factories over the same roster + scope
// helpers index.ts constructs, so wiring them here does not change any behavior
// or the order of side effects at startup (the factory only builds closures).

import type { RecorderNode, ScheduleSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditStore } from "./audit-store.js";
import type { AuditTarget } from "./http-types.js";
import { createMeterRoomAccess } from "./meter-room-access.js";
import type { NodeStore } from "./node-store.js";
import type { RecordingStore } from "./recording-store.js";
import type { RoomStore } from "./room-store.js";
import { nodeRoomIds } from "./room-resolution.js";
import type { ScheduleStore } from "./schedule-store.js";

type User = NonNullable<AuthResult["user"]>;
type NodeRecord = RecorderNode;

export function createScopedResources({
  accessPolicyDecision,
  auditStore,
  hasResourceScope,
  nodeStore,
  recordingStore,
  roomStore,
  rosterRoomIds,
  scheduleStore,
}: {
  accessPolicyDecision: (
    user: User,
    targets: AuditTarget[],
  ) => Promise<{ effect?: string } | undefined | null>;
  auditStore: AuditStore;
  hasResourceScope: (user: AuthResult["user"], target: AuditTarget) => Promise<boolean>;
  nodeStore: NodeStore;
  recordingStore: RecordingStore;
  roomStore: RoomStore;
  rosterRoomIds: (user: User) => Promise<Set<string>>;
  scheduleStore: ScheduleStore;
}) {
  // Per-room meter/monitor access decisions (extracted to keep this file within the
  // LOC budget). Injected with this module's roster + scope helpers.
  const { canServeWholeNodeMonitor, filterMeterFrameForUser, hasFullNodeAuthority } =
    createMeterRoomAccess({
      accessPolicyDecision: (user, targets) => accessPolicyDecision(user, targets),
      hasResourceScope: (user, target) => hasResourceScope(user, target),
      rosterRoomIds: (user) => rosterRoomIds(user),
    });

  async function scopedNodes(user: NonNullable<AuthResult["user"]>) {
    const userRoomIds = await rosterRoomIds(user);
    const result: NodeRecord[] = [];

    for (const node of await nodeStore.list()) {
      // A node is visible if the user has a roster capability in ANY room that owns
      // one of its channels (a shared node surfaces to every rostered room), or via
      // a direct node grant. Per-channel data is filtered separately downstream.
      if (
        intersects(userRoomIds, nodeRoomIds(node)) ||
        (await hasResourceScope(user, { id: node.id, type: "node" }))
      ) {
        result.push(node);
      }
    }

    return result;
  }

  function intersects(left: Set<string>, right: Set<string>) {
    for (const value of right) {
      if (left.has(value)) {
        return true;
      }
    }

    return false;
  }

  async function scopedSchedules(user: NonNullable<AuthResult["user"]>) {
    const userRoomIds = await rosterRoomIds(user);
    const result: ScheduleSummary[] = [];

    for (const schedule of await scheduleStore.list()) {
      // A schedule follows its own persisted room (its selected channels' room).
      const inRosterRoom = schedule.roomId !== undefined && userRoomIds.has(schedule.roomId);

      if (inRosterRoom || (await hasResourceScope(user, { id: schedule.id, type: "schedule" }))) {
        result.push(schedule);
      }
    }

    return result;
  }

  // Rooms visible to a user: everything for owner/admin, else rooms they hold a
  // roster capability in plus the rooms of any nodes they are otherwise scoped to.
  async function scopedRooms(user: NonNullable<AuthResult["user"]>) {
    const allRooms = await roomStore.list();

    if (user.roles.includes("owner") || user.roles.includes("admin")) {
      return allRooms;
    }

    const roomIds = await rosterRoomIds(user);

    // Rooms the caller holds direct room authority on (a room grant or access-policy
    // allow) — so a room-scoped principal still sees exactly its own room(s).
    for (const room of allRooms) {
      if (!roomIds.has(room.id) && (await hasResourceScope(user, { id: room.id, type: "room" }))) {
        roomIds.add(room.id);
      }
    }

    // FULL node authority (a direct node/site/wildcard grant or node/site policy —
    // NOT a room-derived node scope) surfaces every room that owns one of the node's
    // channels. Using hasFullNodeAuthority, not hasResourceScope on the node target
    // (which expands to the room UNION), is what keeps a single-room grant from
    // leaking a shared node's sibling rooms into the room list.
    for (const node of await nodeStore.list()) {
      if (await hasFullNodeAuthority(user, node)) {
        for (const roomId of nodeRoomIds(node)) {
          roomIds.add(roomId);
        }
      }
    }

    return allRooms.filter((room) => roomIds.has(room.id));
  }

  // Resolves who created a schedule from its create audit event (schedules do not
  // store a creator); used for the room overview's "scheduled by" attribution.
  async function scheduledByName(scheduleId: string) {
    const [event] = await auditStore.list({
      action: "schedules.create.succeeded",
      limit: 1,
      target: scheduleId,
    });

    return event?.actor.name;
  }

  async function scopedRecordings(user: NonNullable<AuthResult["user"]>) {
    const userRoomIds = await rosterRoomIds(user);
    const result = [];

    for (const recording of await recordingStore.list()) {
      // A recording follows its own persisted room (captured from its channels), so
      // a shared node never leaks one room's recordings to the other room's roster.
      const inRosterRoom = recording.roomId !== undefined && userRoomIds.has(recording.roomId);

      if (inRosterRoom || (await hasResourceScope(user, { id: recording.id, type: "recording" }))) {
        result.push(recording);
      }
    }

    return result;
  }

  return {
    canServeWholeNodeMonitor,
    filterMeterFrameForUser,
    hasFullNodeAuthority,
    scheduledByName,
    scopedNodes,
    scopedRecordings,
    scopedRooms,
    scopedSchedules,
  };
}
