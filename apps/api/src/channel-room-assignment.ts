// Pure helpers for per-channel room assignment, extracted from node-store.ts to
// keep it within the LOC budget. NodeStoreError is only referenced at call time
// (inside a function body), so the node-store <-> this-module import cycle is safe.

import type { RecorderNode } from "@rakkr/shared";

import { NodeStoreError, type ChannelRoomAssignment } from "./node-store.js";

export function channelAssignmentKey(interfaceId: string, channelIndex: number): string {
  return `${interfaceId}:${channelIndex}`;
}

export function channelRoomAssignmentMap(
  assignments: ChannelRoomAssignment[],
): Map<string, string | null> {
  return new Map(
    assignments.map((assignment) => [
      channelAssignmentKey(assignment.interfaceId, assignment.channelIndex),
      assignment.roomId,
    ]),
  );
}

// Rejects assignments whose interface is not on this node or whose channel index
// is out of range, so a channel-room assignment can never point off-node.
export function assertAssignmentsBelongToNode(
  node: RecorderNode,
  assignments: ChannelRoomAssignment[],
) {
  const interfacesById = new Map(
    node.interfaces.map((audioInterface) => [audioInterface.id, audioInterface]),
  );

  for (const assignment of assignments) {
    const audioInterface = interfacesById.get(assignment.interfaceId);

    if (!audioInterface) {
      throw new NodeStoreError(
        `Interface ${assignment.interfaceId} does not belong to node ${node.id}`,
        "interface_not_found",
      );
    }

    if (assignment.channelIndex < 1 || assignment.channelIndex > audioInterface.channelCount) {
      throw new NodeStoreError(
        `Channel ${assignment.channelIndex} is out of range for interface ${assignment.interfaceId}`,
        "channel_not_found",
      );
    }
  }
}
