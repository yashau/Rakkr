// Per-room access decisions for a node's live channel data (meters + monitor
// audio), extracted from index.ts to keep it within the LOC budget. Room ownership
// is per-channel, so a caller on a SHARED node may only see the channels their
// rooms own. Meters can be filtered per-channel; the monitor audio chunk is a
// single pre-mixed WAV that cannot, so it is refused instead of partitioned.

import type { MeterFrame, RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditTarget } from "./http-types.js";
import { channelRoomId } from "./room-resolution.js";

type User = NonNullable<AuthResult["user"]>;

export function createMeterRoomAccess({
  hasResourceScope,
  rosterRoomIds,
}: {
  hasResourceScope: (user: User, target: AuditTarget) => Promise<boolean>;
  rosterRoomIds: (user: User) => Promise<Set<string>>;
}) {
  // The rooms whose channel data a user may see on a node. "all" for owner/admin or
  // a direct node grant (full node authority); otherwise the user's rostered rooms,
  // so a shared node exposes only the caller's channels.
  async function meterRoomAccess(user: User, node: RecorderNode): Promise<Set<string> | "all"> {
    if (user.roles.includes("owner") || user.roles.includes("admin")) {
      return "all";
    }

    if (await hasResourceScope(user, { id: node.id, type: "node" })) {
      return "all";
    }

    return rosterRoomIds(user);
  }

  // Strict per-channel meter filtering: drop level rows for channels the caller's
  // rooms do not own so a shared node never leaks another room's meters.
  async function filterMeterFrameForUser(
    user: User,
    node: RecorderNode,
    frame: MeterFrame,
  ): Promise<MeterFrame> {
    const access = await meterRoomAccess(user, node);

    if (access === "all") {
      return frame;
    }

    return {
      ...frame,
      levels: frame.levels.filter((level) => {
        const roomId = channelRoomId(node, frame.interfaceId, level.channelIndex);

        return roomId !== undefined && access.has(roomId);
      }),
    };
  }

  // Whether a caller may receive the WHOLE-node live monitor audio. Unlike a meter
  // frame (filtered per-channel), the monitor chunk is a single pre-mixed WAV that
  // cannot be partitioned per room after the fact — so it may only be served when
  // the caller owns every channel's audio: full node authority ("all"), or their
  // rostered rooms cover every channel's room (a channel with no room, or one in a
  // room the caller lacks, would leak). Fail-closed on a shared node.
  async function canServeWholeNodeMonitor(user: User, node: RecorderNode): Promise<boolean> {
    const access = await meterRoomAccess(user, node);

    if (access === "all") {
      return true;
    }

    for (const audioInterface of node.interfaces) {
      for (const channel of audioInterface.channels) {
        const roomId = channelRoomId(node, audioInterface.id, channel.index);

        if (roomId === undefined || !access.has(roomId)) {
          return false;
        }
      }
    }

    return true;
  }

  return { canServeWholeNodeMonitor, filterMeterFrameForUser, meterRoomAccess };
}
