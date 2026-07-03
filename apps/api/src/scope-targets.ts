// Pure resource-scope target-expansion helpers extracted from index.ts to keep
// that module within the LOC budget. These functions take (targets, id/…,
// knownNodes) and mutate the targets array; they do not reference any store or
// closure variable.

import type { RecorderNode } from "@rakkr/shared";

import type { AuditTarget } from "./http-types.js";
import { channelRoomId, interfaceRoomIds, nodeRoomIds } from "./room-resolution.js";

type NodeRecord = RecorderNode;
type InterfaceRecord = NodeRecord["interfaces"][number];

// Room ownership is per-channel, so each resource level resolves to a DIFFERENT
// set of rooms: a channel to its own room, an interface to the union of its
// channels' rooms, and a node to the union across all its channels. Keeping the
// resource hierarchy (channel -> interface -> node -> site) for role-grant
// matching, but scoping the room target per level is what keeps a shared node's
// rooms from leaking into each other.

export function addNodeScopeTargets(
  targets: AuditTarget[],
  nodeId: string,
  knownNodes: NodeRecord[],
) {
  const node = knownNodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    return;
  }

  addNodeResourceTargets(targets, node);

  for (const roomId of nodeRoomIds(node)) {
    targets.push({ id: roomId, type: "room" });
  }
}

export function addInterfaceScopeTargets(
  targets: AuditTarget[],
  interfaceId: string,
  knownNodes: NodeRecord[],
) {
  const match = interfaceNode(interfaceId, knownNodes);

  if (!match) {
    return;
  }

  targets.push({ id: match.audioInterface.id, type: "interface" });
  addNodeResourceTargets(targets, match.node);

  for (const roomId of interfaceRoomIds(match.node, match.audioInterface.id)) {
    targets.push({ id: roomId, type: "room" });
  }
}

export function addChannelScopeTargets(
  targets: AuditTarget[],
  channelId: string,
  knownNodes: NodeRecord[],
) {
  const match = channelNode(channelId, knownNodes);

  if (!match) {
    return;
  }

  targets.push({ id: match.channelId, type: "channel" });
  targets.push({ id: match.audioInterface.id, type: "interface" });
  addNodeResourceTargets(targets, match.node);

  // A channel resolves to its OWN room only — never the whole node's room union.
  const roomId = channelRoomId(match.node, match.audioInterface.id, match.channel.index);

  if (roomId) {
    targets.push({ id: roomId, type: "room" });
  }
}

// Node + site resource targets WITHOUT the node's room union. Used when a target
// already carries its own single room (a recording/schedule/channel) so the node
// hierarchy still authorizes node grants without widening the room scope.
export function addNodeResourceTargets(targets: AuditTarget[], node: NodeRecord) {
  targets.push({ id: node.id, type: "node" });

  if (node.location.site) {
    targets.push({ id: node.location.site, type: "site" });
  }
}

export function interfaceNode(interfaceId: string, knownNodes: NodeRecord[]) {
  for (const node of knownNodes) {
    const audioInterface = node.interfaces.find((candidate) => candidate.id === interfaceId);

    if (audioInterface) {
      return { audioInterface, node };
    }
  }

  return undefined;
}

export function channelNode(channelId: string, knownNodes: NodeRecord[]) {
  for (const node of knownNodes) {
    for (const audioInterface of node.interfaces) {
      const channel = audioInterface.channels.find((candidate) =>
        channelScopeIds(node, audioInterface, candidate.index).includes(channelId),
      );

      if (channel) {
        return {
          audioInterface,
          channel,
          channelId: `${audioInterface.id}:${channel.index}`,
          node,
        };
      }
    }
  }

  return undefined;
}

export function channelScopeIds(
  node: NodeRecord,
  audioInterface: InterfaceRecord,
  channelIndex: number,
) {
  return [
    `${audioInterface.id}:${channelIndex}`,
    `${node.id}:${audioInterface.id}:${channelIndex}`,
  ];
}
