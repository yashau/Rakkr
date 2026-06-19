import { randomBytes, randomUUID } from "node:crypto";
import {
  and,
  audioChannels,
  audioInterfaces,
  createDatabase,
  eq,
  isNull,
  nodeCredentials,
  nodes as nodeRows,
} from "@rakkr/db";
import type { AudioInterface, NodeRuntime, NodeStatus, RecorderNode } from "@rakkr/shared";

import { hashToken, isUuid } from "./auth-utils.js";
import { nodeWithDerivedLiveness } from "./node-liveness.js";

type AudioChannelRow = typeof audioChannels.$inferSelect;
type AudioInterfaceRow = typeof audioInterfaces.$inferSelect;
type NodeRow = typeof nodeRows.$inferSelect;

export interface NodeEnrollmentInput {
  agentVersion: string;
  alias: string;
  hostname: string;
  interfaces: NodeInterfaceInput[];
  ipAddresses: string[];
  location: {
    building?: string;
    floor?: string;
    room: string;
    site: string;
  };
  notes?: string;
  runtime?: NodeRuntime;
  tags: string[];
}

export interface NodeHeartbeatInput {
  agentVersion: string;
  hostname: string;
  ipAddresses: string[];
  runtime?: NodeRuntime;
  status: NodeStatus;
}

export interface NodeUpdateInput {
  alias?: string;
  hostname?: string;
  ipAddresses?: string[];
  location?: {
    building?: string | null;
    floor?: string | null;
    room?: string;
    site?: string;
  };
  notes?: string | null;
  tags?: string[];
}

export interface NodeInterfaceUpdateInput {
  alias?: string;
  channels?: Array<{
    alias: string;
    index: number;
  }>;
  hardwarePath?: string | null;
  sampleRates?: number[];
  serialNumber?: string | null;
  systemName?: string;
  systemRef?: string;
}

export interface NodeInterfaceInput {
  alias: string;
  backend: AudioInterface["backend"];
  channelCount: number;
  channels: Array<{
    alias: string;
    index: number;
  }>;
  hardwarePath?: string;
  sampleRates: number[];
  serialNumber?: string;
  systemName: string;
  systemRef?: string;
}

export interface NodeCredentialEnvelope {
  createdAt: string;
  id: string;
  nodeId: string;
  token: string;
  tokenPrefix: string;
}

export interface NodeEnrollmentResult {
  credential: NodeCredentialEnvelope;
  node: RecorderNode;
}

export interface NodeCredentialAuth {
  credentialId: string;
  nodeId: string;
  tokenPrefix: string;
}

export class NodeStoreError extends Error {
  constructor(
    message: string,
    readonly code: "database_unavailable" | "node_not_found",
  ) {
    super(message);
  }
}

export interface NodeStore {
  authenticateCredential(token: string): Promise<NodeCredentialAuth | undefined>;
  enroll(input: NodeEnrollmentInput, actorUserId?: string): Promise<NodeEnrollmentResult>;
  find(nodeId: string): Promise<RecorderNode | undefined>;
  heartbeat(nodeId: string, input: NodeHeartbeatInput): Promise<RecorderNode | undefined>;
  list(): Promise<RecorderNode[]>;
  rotateCredential(nodeId: string, actorUserId?: string): Promise<NodeEnrollmentResult | undefined>;
  updateInterface(
    nodeId: string,
    interfaceId: string,
    input: NodeInterfaceUpdateInput,
  ): Promise<RecorderNode | undefined>;
  update(nodeId: string, input: NodeUpdateInput): Promise<RecorderNode | undefined>;
}

export function createNodeStore(seedNodes: RecorderNode[] = []): NodeStore {
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl
    ? new PostgresNodeStore(databaseUrl, seedNodes)
    : new SeedOnlyNodeStore(seedNodes);
}

class SeedOnlyNodeStore implements NodeStore {
  constructor(private readonly seedNodes: RecorderNode[]) {}

  async authenticateCredential() {
    return undefined;
  }

  async enroll(): Promise<NodeEnrollmentResult> {
    throw new NodeStoreError("Node enrollment requires Postgres", "database_unavailable");
  }

  async find(nodeId: string) {
    return this.seedNodes.find((node) => node.id === nodeId);
  }

  async heartbeat(nodeId: string, input: NodeHeartbeatInput) {
    const index = this.seedNodes.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      return undefined;
    }

    this.seedNodes[index] = updatedNodeHeartbeat(this.seedNodes[index], input);

    return this.seedNodes[index];
  }

  async list() {
    return this.seedNodes;
  }

  async rotateCredential(): Promise<NodeEnrollmentResult> {
    throw new NodeStoreError("Node credential rotation requires Postgres", "database_unavailable");
  }

  async updateInterface(nodeId: string, interfaceId: string, input: NodeInterfaceUpdateInput) {
    const index = this.seedNodes.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      return undefined;
    }

    const updated = updatedNodeInterface(this.seedNodes[index], interfaceId, input);

    if (!updated) {
      return undefined;
    }

    this.seedNodes[index] = updated;

    return updated;
  }

  async update(nodeId: string, input: NodeUpdateInput) {
    const index = this.seedNodes.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      return undefined;
    }

    this.seedNodes[index] = updatedNode(this.seedNodes[index], input);

    return this.seedNodes[index];
  }
}

class PostgresNodeStore implements NodeStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly seedNodes: RecorderNode[],
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async enroll(input: NodeEnrollmentInput, actorUserId?: string) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node enrollment storage is unavailable", "database_unavailable");
    }

    const [row] = await db.insert(nodeRows).values(nodeInputToRow(input)).returning();

    try {
      await replaceInterfaces(db, row.id, input.interfaces);
      const credential = await this.createCredential(row.id, actorUserId);
      const node = await this.find(row.id);

      if (!node) {
        throw new NodeStoreError("Enrolled node could not be loaded", "node_not_found");
      }

      return { credential, node };
    } catch (error) {
      await db
        .delete(nodeRows)
        .where(eq(nodeRows.id, row.id))
        .catch(() => undefined);
      this.markUnavailable(error);
      throw error;
    }
  }

  async authenticateCredential(token: string) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node credential storage is unavailable", "database_unavailable");
    }

    const [credential] = await db
      .select({
        credentialId: nodeCredentials.id,
        nodeId: nodeCredentials.nodeId,
        tokenPrefix: nodeCredentials.tokenPrefix,
      })
      .from(nodeCredentials)
      .where(
        and(eq(nodeCredentials.tokenHash, hashToken(token)), isNull(nodeCredentials.revokedAt)),
      )
      .limit(1);

    if (!credential) {
      return undefined;
    }

    await db
      .update(nodeCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(nodeCredentials.id, credential.credentialId));

    return credential;
  }

  async find(nodeId: string) {
    return (await this.list()).find((node) => node.id === nodeId);
  }

  async heartbeat(nodeId: string, input: NodeHeartbeatInput) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node heartbeat storage is unavailable", "database_unavailable");
    }

    const [row] = await db.select().from(nodeRows).where(eq(nodeRows.id, nodeId)).limit(1);

    if (!row) {
      return undefined;
    }

    await db
      .update(nodeRows)
      .set({
        agentVersion: input.agentVersion,
        hostname: input.hostname,
        lastSeenAt: new Date(),
        metadata: nodeMetadata(row.metadata, nodeRuntimeFromInput(input.runtime, row.metadata)),
        network: { ipAddresses: input.ipAddresses },
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(nodeRows.id, nodeId));

    return this.find(nodeId);
  }

  async list() {
    const seed = seedNodesEnabled() ? this.seedNodes : [];
    const db = this.availableDatabase();

    if (!db) {
      return seed;
    }

    try {
      const [nodeRecords, interfaceRecords, channelRecords] = await Promise.all([
        db.select().from(nodeRows),
        db.select().from(audioInterfaces),
        db.select().from(audioChannels),
      ]);
      const now = new Date();
      const persisted = nodeRecords.map((node) =>
        nodeWithDerivedLiveness(
          nodeFromRows(
            node,
            interfaceRecords.filter((row) => row.nodeId === node.id),
            channelRecords,
          ),
          now,
        ),
      );
      const persistedIds = new Set(persisted.map((node) => node.id));

      return [...persisted, ...seed.filter((node) => !persistedIds.has(node.id))];
    } catch (error) {
      this.markUnavailable(error);
      return seed;
    }
  }

  async rotateCredential(nodeId: string, actorUserId?: string) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node credential storage is unavailable", "database_unavailable");
    }

    const [node] = await db.select().from(nodeRows).where(eq(nodeRows.id, nodeId)).limit(1);

    if (!node) {
      return undefined;
    }

    await db
      .update(nodeCredentials)
      .set({ revokedAt: new Date() })
      .where(and(eq(nodeCredentials.nodeId, nodeId), isNull(nodeCredentials.revokedAt)));

    return {
      credential: await this.createCredential(nodeId, actorUserId),
      node: (await this.find(nodeId)) ?? nodeFromRows(node, [], []),
    };
  }

  async updateInterface(nodeId: string, interfaceId: string, input: NodeInterfaceUpdateInput) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node interface storage is unavailable", "database_unavailable");
    }

    if (!isUuid(interfaceId)) {
      return undefined;
    }

    const [audioInterface] = await db
      .select()
      .from(audioInterfaces)
      .where(and(eq(audioInterfaces.id, interfaceId), eq(audioInterfaces.nodeId, nodeId)))
      .limit(1);

    if (!audioInterface) {
      return undefined;
    }

    await db
      .update(audioInterfaces)
      .set({
        alias: input.alias ?? audioInterface.alias,
        hardwarePath:
          input.hardwarePath === undefined ? audioInterface.hardwarePath : input.hardwarePath,
        sampleRates: input.sampleRates ?? audioInterface.sampleRates,
        serialNumber:
          input.serialNumber === undefined ? audioInterface.serialNumber : input.serialNumber,
        systemName: input.systemName ?? audioInterface.systemName,
        systemRef: input.systemRef ?? audioInterface.systemRef,
        updatedAt: new Date(),
      })
      .where(eq(audioInterfaces.id, interfaceId));

    for (const channel of input.channels ?? []) {
      await db
        .update(audioChannels)
        .set({ alias: channel.alias })
        .where(
          and(eq(audioChannels.interfaceId, interfaceId), eq(audioChannels.index, channel.index)),
        );
    }

    return this.find(nodeId);
  }

  async update(nodeId: string, input: NodeUpdateInput) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node storage is unavailable", "database_unavailable");
    }

    const [row] = await db.select().from(nodeRows).where(eq(nodeRows.id, nodeId)).limit(1);

    if (!row) {
      return undefined;
    }

    const existing = nodeFromRows(row, [], []);
    const next = updatedNode(existing, input);

    await db
      .update(nodeRows)
      .set({
        alias: next.alias,
        hostname: next.hostname,
        location: next.location,
        network: { ipAddresses: next.ipAddresses },
        notes: next.notes ?? null,
        tags: next.tags,
        updatedAt: new Date(),
      })
      .where(eq(nodeRows.id, nodeId));

    return this.find(nodeId);
  }

  private async createCredential(nodeId: string, actorUserId?: string) {
    const token = `rakkr_node_${randomBytes(32).toString("base64url")}`;
    const [row] = await this.db
      .insert(nodeCredentials)
      .values({
        createdByUserId: actorUserId && isUuid(actorUserId) ? actorUserId : null,
        nodeId,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 24),
      })
      .returning({
        createdAt: nodeCredentials.createdAt,
        id: nodeCredentials.id,
        tokenPrefix: nodeCredentials.tokenPrefix,
      });

    return {
      createdAt: row.createdAt.toISOString(),
      id: row.id,
      nodeId,
      token,
      tokenPrefix: row.tokenPrefix,
    };
  }

  private availableDatabase() {
    return this.dbAvailable ? this.db : undefined;
  }

  private markUnavailable(error: unknown) {
    if (error instanceof NodeStoreError) {
      return;
    }

    this.dbAvailable = false;
    console.warn("node persistence unavailable; using seed nodes", error);
  }
}

async function replaceInterfaces(
  db: ReturnType<typeof createDatabase>,
  nodeId: string,
  interfaces: NodeInterfaceInput[],
) {
  for (const audioInterface of interfaces) {
    const [row] = await db
      .insert(audioInterfaces)
      .values(interfaceInputToRow(nodeId, audioInterface))
      .returning({ id: audioInterfaces.id });
    const channels = channelInputs(audioInterface);

    if (channels.length > 0) {
      await db.insert(audioChannels).values(
        channels.map((channel) => ({
          alias: channel.alias,
          index: channel.index,
          interfaceId: row.id,
        })),
      );
    }
  }
}

function nodeInputToRow(input: NodeEnrollmentInput): typeof nodeRows.$inferInsert {
  return {
    agentVersion: input.agentVersion,
    alias: input.alias,
    hostname: input.hostname,
    id: `node_${randomUUID()}`,
    location: input.location,
    metadata: nodeMetadata({ enrolledAt: new Date().toISOString() }, input.runtime),
    network: {
      ipAddresses: input.ipAddresses,
    },
    notes: input.notes,
    status: "offline",
    tags: input.tags,
  };
}

function interfaceInputToRow(
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

function nodeFromRows(
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
    notes: node.notes ?? undefined,
    runtime: nodeRuntimeFromMetadata(node.metadata),
    status: node.status,
    tags: stringArray(node.tags),
  };
}

function updatedNodeHeartbeat(node: RecorderNode, input: NodeHeartbeatInput): RecorderNode {
  return {
    ...node,
    agentVersion: input.agentVersion,
    hostname: input.hostname,
    ipAddresses: input.ipAddresses,
    lastSeenAt: new Date().toISOString(),
    runtime: input.runtime ?? node.runtime,
    status: input.status,
  };
}

function updatedNode(node: RecorderNode, input: NodeUpdateInput): RecorderNode {
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
    tags: input.tags ?? node.tags,
  };
}

function updatedNodeInterface(
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

function interfaceFromRows(
  audioInterface: AudioInterfaceRow,
  channels: AudioChannelRow[],
): AudioInterface {
  return {
    alias: audioInterface.alias,
    backend: backend(audioInterface.backend),
    channelCount: audioInterface.channelCount,
    channels: channels
      .filter((channel) => channel.interfaceId === audioInterface.id)
      .map((channel) => ({
        alias: channel.alias,
        index: channel.index,
      })),
    hardwarePath: audioInterface.hardwarePath ?? undefined,
    id: audioInterface.id,
    sampleRates: numberArray(audioInterface.sampleRates),
    serialNumber: audioInterface.serialNumber ?? undefined,
    systemName: audioInterface.systemName,
    systemRef: audioInterface.systemRef,
  };
}

function channelInputs(input: NodeInterfaceInput) {
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

function nodeMetadata(existingMetadata: unknown, runtime: NodeRuntime | undefined) {
  return {
    ...record(existingMetadata),
    ...(runtime ? { runtime } : {}),
  };
}

function nodeRuntimeFromInput(runtime: NodeRuntime | undefined, existingMetadata: unknown) {
  return runtime ?? nodeRuntimeFromMetadata(existingMetadata);
}

function nodeRuntimeFromMetadata(metadata: unknown): NodeRuntime | undefined {
  const runtime = record(metadata)?.runtime;
  const parsed = record(runtime);

  if (!parsed) {
    return undefined;
  }

  return {
    architecture: stringOrUndefined(parsed.architecture),
    audioBackends: audioBackends(parsed.audioBackends),
    kernelRelease: stringOrUndefined(parsed.kernelRelease),
    osName: stringOrUndefined(parsed.osName),
    uptimeSeconds: nonNegativeIntegerOrUndefined(parsed.uptimeSeconds),
  };
}

function backend(value: string): AudioInterface["backend"] {
  return value === "alsa" || value === "jack" || value === "pipewire" ? value : "unknown";
}

function audioBackends(value: unknown): NodeRuntime["audioBackends"] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is NodeRuntime["audioBackends"][number] =>
          item === "alsa" || item === "jack" || item === "pipewire" || item === "unknown",
      )
    : [];
}

function numberArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function nonNegativeIntegerOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function seedNodesEnabled() {
  return process.env.RAKKR_SEED_DEMO_DATA !== "0";
}
