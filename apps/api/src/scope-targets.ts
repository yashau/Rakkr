// Pure resource-scope target-expansion helpers extracted from index.ts to keep
// that module within the LOC budget. These functions take (targets, id/…,
// knownNodes) and mutate the targets array; they do not reference any store or
// closure variable.

import type { RecorderNode } from "@rakkr/shared";

import type { AuditTarget } from "./http-types.js";

type NodeRecord = RecorderNode;
type InterfaceRecord = NodeRecord["interfaces"][number];

export function addNodeScopeTargets(
  targets: AuditTarget[],
  nodeId: string,
  knownNodes: NodeRecord[],
) {
  const node = knownNodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    return;
  }

  targets.push({ id: node.id, type: "node" });
  addRoomScopeTargets(targets, node);
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
  addNodeScopeTargets(targets, match.node.id, knownNodes);
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
  addInterfaceScopeTargets(targets, match.audioInterface.id, knownNodes);
}

export function addRoomScopeTargets(targets: AuditTarget[], node: NodeRecord) {
  // Site remains an optional (metadata) scope target for site-wide admin grants;
  // the room is now keyed on the node's first-class roomId rather than the
  // free-text <site>/<room> string.
  if (node.location.site) {
    targets.push({ id: node.location.site, type: "site" });
  }

  if (node.roomId) {
    targets.push({ id: node.roomId, type: "room" });
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
