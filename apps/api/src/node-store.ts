import { randomBytes } from "node:crypto";
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
import type { AudioInterface, RecorderNode } from "@rakkr/shared";

import { hashToken, isUuid } from "./auth-utils.js";

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
  tags: string[];
}

export interface NodeInterfaceInput {
  alias: string;
  backend: AudioInterface["backend"];
  channelCount: number;
  channels: Array<{
    alias: string;
    index: number;
  }>;
  sampleRates: number[];
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

export class NodeStoreError extends Error {
  constructor(
    message: string,
    readonly code: "database_unavailable" | "node_not_found",
  ) {
    super(message);
  }
}

export interface NodeStore {
  enroll(input: NodeEnrollmentInput, actorUserId?: string): Promise<NodeEnrollmentResult>;
  find(nodeId: string): Promise<RecorderNode | undefined>;
  list(): Promise<RecorderNode[]>;
  rotateCredential(nodeId: string, actorUserId?: string): Promise<NodeEnrollmentResult | undefined>;
}

export function createNodeStore(seedNodes: RecorderNode[] = []): NodeStore {
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl
    ? new PostgresNodeStore(databaseUrl, seedNodes)
    : new SeedOnlyNodeStore(seedNodes);
}

class SeedOnlyNodeStore implements NodeStore {
  constructor(private readonly seedNodes: RecorderNode[]) {}

  async enroll(): Promise<NodeEnrollmentResult> {
    throw new NodeStoreError("Node enrollment requires Postgres", "database_unavailable");
  }

  async find(nodeId: string) {
    return this.seedNodes.find((node) => node.id === nodeId);
  }

  async list() {
    return this.seedNodes;
  }

  async rotateCredential(): Promise<NodeEnrollmentResult> {
    throw new NodeStoreError("Node credential rotation requires Postgres", "database_unavailable");
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

  async find(nodeId: string) {
    return (await this.list()).find((node) => node.id === nodeId);
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
      const persisted = nodeRecords.map((node) =>
        nodeFromRows(
          node,
          interfaceRecords.filter((row) => row.nodeId === node.id),
          channelRecords,
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

    if (!isUuid(nodeId)) {
      return undefined;
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
    location: input.location,
    metadata: {
      enrolledAt: new Date().toISOString(),
    },
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
    nodeId,
    sampleRates: input.sampleRates,
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
    status: node.status,
    tags: stringArray(node.tags),
  };
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
    id: audioInterface.id,
    sampleRates: numberArray(audioInterface.sampleRates),
    systemName: audioInterface.systemName,
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

function backend(value: string): AudioInterface["backend"] {
  return value === "alsa" || value === "jack" || value === "pipewire" ? value : "unknown";
}

function numberArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
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
