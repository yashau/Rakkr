import { randomUUID } from "node:crypto";
import { audioChannels, audioInterfaces, nodes as nodeRows } from "@rakkr/db";
import type { AudioInterface, RecorderNode } from "@rakkr/shared";

import {
  nodeAudioDefaultsFromMetadata,
  nodeMetadata,
  nodeRecordingCapacityFromMetadata,
  nodeRuntimeFromMetadata,
  numberArray,
  record,
  stringArray,
  stringOrUndefined,
} from "./node-metadata.js";
import type { NodeEnrollmentInput, NodeInterfaceInput } from "./node-store.js";

// Pure row <-> RecorderNode mappers for the node store. Extracted from
// node-store.ts to keep it under the LOC budget; the type imports from
// node-store.js are erased, so the store <-> mappers edge is not a runtime cycle.

type AudioChannelRow = typeof audioChannels.$inferSelect;
type AudioInterfaceRow = typeof audioInterfaces.$inferSelect;
type NodeRow = typeof nodeRows.$inferSelect;

export function nodeInputToRow(input: NodeEnrollmentInput): typeof nodeRows.$inferInsert {
  return {
    agentVersion: input.agentVersion,
    alias: input.alias,
    hostname: input.hostname,
    id: `node_${randomUUID()}`,
    location: input.location,
    metadata: nodeMetadata(
      { enrolledAt: new Date().toISOString() },
      input.runtime,
      input.recordingCapacity,
      input.audioDefaults,
    ),
    network: {
      ipAddresses: input.ipAddresses,
    },
    notes: input.notes,
    status: "offline",
    tags: input.tags,
  };
}

export function interfaceInputToRow(
  nodeId: string,
  input: NodeInterfaceInput,
): typeof audioInterfaces.$inferInsert {
  return {
    alias: input.alias,
    backend: input.backend,
    channelCount: input.channelCount,
    hardwarePath: input.hardwarePath ?? null,
    nodeId,
    sampleRates: input.sampleRates,
    serialNumber: input.serialNumber ?? null,
    systemName: input.systemName,
    systemRef: input.systemRef ?? input.systemName,
  };
}

export function recorderNodeToRow(node: RecorderNode): typeof nodeRows.$inferInsert {
  return {
    agentVersion: node.agentVersion,
    alias: node.alias,
    hostname: node.hostname,
    id: node.id,
    lastSeenAt: new Date(node.lastSeenAt),
    location: node.location,
    metadata: nodeMetadata(
      { enrolledAt: new Date().toISOString() },
      node.runtime,
      node.recordingCapacity,
      node.audioDefaults,
    ),
    network: { ipAddresses: node.ipAddresses },
    notes: node.notes,
    roomId: node.roomId ?? null,
    status: node.status,
    tags: node.tags,
  };
}

export function recorderInterfaceToRow(
  nodeId: string,
  audioInterface: AudioInterface,
): typeof audioInterfaces.$inferInsert {
  return {
    alias: audioInterface.alias,
    backend: audioInterface.backend,
    channelCount: audioInterface.channelCount,
    hardwarePath: audioInterface.hardwarePath ?? null,
    id: audioInterface.id,
    nodeId,
    sampleRates: audioInterface.sampleRates,
    serialNumber: audioInterface.serialNumber ?? null,
    systemName: audioInterface.systemName,
    systemRef: audioInterface.systemRef ?? audioInterface.systemName,
  };
}

export function nodeFromRows(
  node: NodeRow,
  interfaces: AudioInterfaceRow[],
  channels: AudioChannelRow[],
): RecorderNode {
  return {
    agentVersion: node.agentVersion,
    alias: node.alias,
    hostname: node.hostname,
    id: node.id,
    interfaces: interfaces.map((audioInterface) => interfaceFromRows(audioInterface, channels)),
    ipAddresses: stringArray(record(node.network)?.ipAddresses),
    lastSeenAt: (node.lastSeenAt ?? node.createdAt).toISOString(),
    location: locationFromValue(node.location),
    roomId: node.roomId ?? undefined,
    notes: node.notes ?? undefined,
    audioDefaults: nodeAudioDefaultsFromMetadata(node.metadata),
    recordingCapacity: nodeRecordingCapacityFromMetadata(node.metadata),
    runtime: nodeRuntimeFromMetadata(node.metadata),
    status: node.status,
    tags: stringArray(node.tags),
  };
}

function interfaceFromRows(
  audioInterface: AudioInterfaceRow,
  channels: AudioChannelRow[],
): AudioInterface {
  return {
    absent: audioInterface.absentAt ? true : undefined,
    alias: audioInterface.alias,
    backend: backend(audioInterface.backend),
    channelCount: audioInterface.channelCount,
    channels: channels
      .filter((channel) => channel.interfaceId === audioInterface.id)
      .map((channel) => ({
        alias: channel.alias,
        index: channel.index,
        roomId: channel.roomId ?? undefined,
      })),
    hardwarePath: audioInterface.hardwarePath ?? undefined,
    id: audioInterface.id,
    sampleRates: numberArray(audioInterface.sampleRates),
    serialNumber: audioInterface.serialNumber ?? undefined,
    systemName: audioInterface.systemName,
    systemRef: audioInterface.systemRef,
  };
}

export function channelInputs(input: NodeInterfaceInput) {
  if (input.channels.length > 0) {
    return input.channels;
  }

  return Array.from({ length: input.channelCount }, (_, index) => ({
    alias: `Channel ${index + 1}`,
    index: index + 1,
  }));
}

function locationFromValue(value: unknown): RecorderNode["location"] {
  const parsed = record(value);

  return {
    building: stringOrUndefined(parsed?.building),
    floor: stringOrUndefined(parsed?.floor),
    room: stringOrUndefined(parsed?.room) ?? "Unknown Room",
    site: stringOrUndefined(parsed?.site) ?? "Unknown Site",
  };
}

function backend(value: string): AudioInterface["backend"] {
  return value === "alsa" || value === "jack" || value === "pipewire" ? value : "unknown";
}
