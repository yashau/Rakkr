// Per-room access decisions for a node's live channel data (meters + monitor
// audio), extracted from index.ts to keep it within the LOC budget. Room ownership
// is per-channel, so a caller on a SHARED node may only see the channels their
// rooms own. Meters can be filtered per-channel; the monitor audio chunk is a
// single pre-mixed WAV that cannot, so it is refused instead of partitioned.

import type { MeterFrame, RecorderNode } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditTarget } from "./http-types.js";
import { channelRoomId, nodeRoomIds } from "./room-resolution.js";

type User = NonNullable<AuthResult["user"]>;

// Computes the meter frame a caller may receive for a live meter event (the
// /meter-events SSE stream): resolves the node THROUGH the caller's scoped-node
// set — the same ROSTER-INCLUSIVE authority /meters uses via scopedNodes, so a
// rostered room operator (no direct node grant) is admitted for the channels their
// rooms own — then applies strict per-channel filtering (mirroring /meters).
// Returns undefined when the node is not in the caller's scope or can't be
// resolved, so the stream emits nothing rather than an unfiltered frame that would
// leak sibling-room levels on a shared node. Resolving via resolveScopedNode (not a
// node-target hasResourceScope) is what admits the rostered operator the old
// node-scope gate fail-closed on.
export async function resolveVisibleMeterFrame(
  user: User,
  frame: MeterFrame,
  deps: {
    filterMeterFrame: (user: User, node: RecorderNode, frame: MeterFrame) => Promise<MeterFrame>;
    resolveScopedNode: (user: User, nodeId: string) => Promise<RecorderNode | undefined>;
  },
): Promise<MeterFrame | undefined> {
  const node = await deps.resolveScopedNode(user, frame.nodeId);

  if (!node) {
    return undefined;
  }

  return deps.filterMeterFrame(user, node, frame);
}

export function createMeterRoomAccess({
  accessPolicyDecision,
  hasResourceScope,
  rosterRoomIds,
}: {
  // Access-policy decision for a target set (no room expansion). Used to detect
  // node/site-level authority distinctly from room-derived node scope.
  accessPolicyDecision: (
    user: User,
    targets: AuditTarget[],
  ) => Promise<{ effect?: string } | undefined | null>;
  // Whether the user is scoped to a single target (role/grant/policy). Used per
  // room to build the caller's owned-room set.
  hasResourceScope: (user: User, target: AuditTarget) => Promise<boolean>;
  rosterRoomIds: (user: User) => Promise<Set<string>>;
}) {
  // FULL-node authority: the caller may see EVERY channel regardless of room. This
  // is owner/admin, or a node/site/wildcard grant or a node/site access-policy
  // allow — NOT a room-scoped grant/policy. Critically, this must NOT reuse a
  // node-target resource-scope check: that expands to the node's room UNION, so a
  // single owned room would falsely confer whole-node authority and leak the other
  // rooms' meters/audio on a shared node.
  async function hasFullNodeAuthority(user: User, node: RecorderNode): Promise<boolean> {
    if (user.roles.includes("owner") || user.roles.includes("admin")) {
      return true;
    }

    const targets: AuditTarget[] = [{ id: node.id, type: "node" }];

    if (node.location.site) {
      targets.push({ id: node.location.site, type: "site" });
    }

    const policyDecision = await accessPolicyDecision(user, targets);

    if (policyDecision?.effect === "deny") {
      return false;
    }

    if (policyDecision?.effect === "allow") {
      return true;
    }

    return targets.some((candidate) =>
      user.resourceGrants.some(
        (grant) =>
          (grant.resourceType === candidate.type || grant.resourceType === "*") &&
          (grant.resourceId === candidate.id || grant.resourceId === "*"),
      ),
    );
  }

  // The rooms whose channel data a user may see on a node. "all" for full-node
  // authority; otherwise the caller's rostered rooms plus any of the node's rooms
  // they hold direct room authority on (a room grant/policy), so a shared node
  // exposes only the caller's own channels.
  async function meterRoomAccess(user: User, node: RecorderNode): Promise<Set<string> | "all"> {
    if (await hasFullNodeAuthority(user, node)) {
      return "all";
    }

    const owned = new Set(await rosterRoomIds(user));

    for (const roomId of nodeRoomIds(node)) {
      if (!owned.has(roomId) && (await hasResourceScope(user, { id: roomId, type: "room" }))) {
        owned.add(roomId);
      }
    }

    return owned;
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
  // owned rooms cover every channel's room (a channel with no room, or one in a
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

  return {
    canServeWholeNodeMonitor,
    filterMeterFrameForUser,
    hasFullNodeAuthority,
    meterRoomAccess,
  };
}
