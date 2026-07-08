import type { MeterFrame, RecorderNode } from "@rakkr/shared";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeInterfaceUpdateInput, NodeStore, NodeUpdateInput } from "../src/node-store.js";

// Shared fakes/fixtures for the node route tests. Extracted from
// node-routes.test.ts to keep that file under the 1000-LOC guard (audit Run 1).

export function memoryMeterFrameStore(frames: MeterFrame[]): MeterFrameStore {
  return {
    async history(nodeId, limit = frames.length) {
      return frames.filter((frame) => frame.nodeId === nodeId).slice(0, limit);
    },
    async latest(nodeId) {
      return frames.find((frame) => frame.nodeId === nodeId);
    },
    async save(frame) {
      frames.unshift(frame);

      return {
        frame,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

export function memoryNodeStore(nodes: RecorderNode[]): NodeStore {
  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return nodes;
    },
    async rotateCredential() {
      throw new Error("not implemented");
    },
    async updateInterface(nodeId: string, interfaceId: string, input: NodeInterfaceUpdateInput) {
      const index = nodes.findIndex((candidate) => candidate.id === nodeId);

      if (index < 0) {
        return undefined;
      }

      const interfaceIndex = nodes[index].interfaces.findIndex(
        (candidate) => candidate.id === interfaceId,
      );

      if (interfaceIndex < 0) {
        return undefined;
      }

      const audioInterface = nodes[index].interfaces[interfaceIndex];
      const channelAliases = new Map(
        (input.channels ?? []).map((channel) => [channel.index, channel.alias]),
      );
      const interfaces = [...nodes[index].interfaces];

      interfaces[interfaceIndex] = {
        ...audioInterface,
        alias: input.alias ?? audioInterface.alias,
        channels: audioInterface.channels.map((channel) => ({
          ...channel,
          alias: channelAliases.get(channel.index) ?? channel.alias,
        })),
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
      nodes[index] = {
        ...nodes[index],
        interfaces,
      };

      return nodes[index];
    },
    async update(nodeId, input: NodeUpdateInput) {
      const index = nodes.findIndex((candidate) => candidate.id === nodeId);

      if (index < 0) {
        return undefined;
      }

      nodes[index] = {
        ...nodes[index],
        alias: input.alias ?? nodes[index].alias,
        hostname: input.hostname ?? nodes[index].hostname,
        ipAddresses: input.ipAddresses ?? nodes[index].ipAddresses,
        location: {
          ...nodes[index].location,
          ...input.location,
        },
        notes: input.notes === undefined ? nodes[index].notes : (input.notes ?? undefined),
        audioDefaults:
          input.audioDefaults === undefined ? nodes[index].audioDefaults : input.audioDefaults,
        recordingCapacity: input.recordingCapacity ?? nodes[index].recordingCapacity,
        tags: input.tags ?? nodes[index].tags,
      };

      return nodes[index];
    },
  };
}

export function wavChunk() {
  const bytes = Buffer.alloc(48);

  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(100, 44);
  bytes.writeInt16LE(-100, 46);

  return bytes;
}
