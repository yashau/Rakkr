import type { AudioInterface, NodeStatus, RecorderNode } from "@rakkr/shared";

import { nonEmptyAudioDefaults } from "./node-metadata.js";
import type {
  NodeHeartbeatInput,
  NodeInterfaceUpdateInput,
  NodeUpdateInput,
} from "./node-store.js";

// Pure RecorderNode transforms applied by the node store's heartbeat/update
// paths. Extracted from node-store.ts to keep it under the LOC budget; the type
// imports above are erased, so the store <-> updates edge is not a runtime cycle.

// A heartbeat proves the node is in contact right now, so it must never leave
// the node looking never-contacted (`provisioning`) or stale (`offline`) — the
// controller owns the lifecycle state machine, so a first heartbeat promotes a
// provisioning node to live, and a node (or a stale/rolled-back agent) cannot
// self-report itself back out of offline detection (audit N4). Other live
// statuses the agent may report (recording/degraded/alerting) pass through.
export function heartbeatStatus(status: NodeStatus): NodeStatus {
  return status === "provisioning" || status === "offline" ? "online" : status;
}

export function updatedNodeHeartbeat(node: RecorderNode, input: NodeHeartbeatInput): RecorderNode {
  return {
    ...node,
    agentVersion: input.agentVersion,
    hostname: input.hostname,
    ipAddresses: input.ipAddresses,
    lastSeenAt: new Date().toISOString(),
    runtime: input.runtime ?? node.runtime,
    status: heartbeatStatus(input.status),
  };
}

export function updatedNode(node: RecorderNode, input: NodeUpdateInput): RecorderNode {
  return {
    ...node,
    alias: input.alias ?? node.alias,
    hostname: input.hostname ?? node.hostname,
    ipAddresses: input.ipAddresses ?? node.ipAddresses,
    location: {
      ...node.location,
      ...definedLocation(input.location),
    },
    notes: input.notes === undefined ? node.notes : (input.notes ?? undefined),
    audioDefaults:
      input.audioDefaults === undefined
        ? node.audioDefaults
        : nonEmptyAudioDefaults(input.audioDefaults),
    recordingCapacity: input.recordingCapacity ?? node.recordingCapacity,
    tags: input.tags ?? node.tags,
  };
}

export function updatedNodeInterface(
  node: RecorderNode,
  interfaceId: string,
  input: NodeInterfaceUpdateInput,
): RecorderNode | undefined {
  const interfaceIndex = node.interfaces.findIndex(
    (audioInterface) => audioInterface.id === interfaceId,
  );

  if (interfaceIndex < 0) {
    return undefined;
  }

  const audioInterface = node.interfaces[interfaceIndex];
  const nextInterfaces = [...node.interfaces];

  nextInterfaces[interfaceIndex] = {
    ...audioInterface,
    alias: input.alias ?? audioInterface.alias,
    channels: input.channels
      ? updatedChannels(audioInterface.channels, input.channels)
      : audioInterface.channels,
    hardwarePath:
      input.hardwarePath === undefined
        ? audioInterface.hardwarePath
        : (input.hardwarePath ?? undefined),
    sampleRates: input.sampleRates ?? audioInterface.sampleRates,
    serialNumber:
      input.serialNumber === undefined
        ? audioInterface.serialNumber
        : (input.serialNumber ?? undefined),
    systemName: input.systemName ?? audioInterface.systemName,
    systemRef: input.systemRef ?? audioInterface.systemRef,
  };

  return {
    ...node,
    interfaces: nextInterfaces,
  };
}

function updatedChannels(
  channels: AudioInterface["channels"],
  updates: NonNullable<NodeInterfaceUpdateInput["channels"]>,
) {
  const updateByIndex = new Map(updates.map((channel) => [channel.index, channel.alias]));

  return channels.map((channel) => ({
    ...channel,
    alias: updateByIndex.get(channel.index) ?? channel.alias,
  }));
}

function definedLocation(location: NodeUpdateInput["location"]) {
  const next: Partial<RecorderNode["location"]> = {};

  for (const [key, value] of Object.entries(location ?? {}) as Array<
    [keyof RecorderNode["location"], string | null | undefined]
  >) {
    if (value !== undefined) {
      next[key] = value ?? undefined;
    }
  }

  return next;
}
