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
import type {
  AudioInterface,
  NodeAudioCommandDefaults,
  NodeRecordingCapacity,
  NodeRuntime,
  NodeStatus,
  RecorderNode,
} from "@rakkr/shared";

import { hashToken, isUuid } from "./auth-utils.js";
import {
  assertAssignmentsBelongToNode,
  channelAssignmentKey,
  channelRoomAssignmentMap,
} from "./channel-room-assignment.js";
import { nodeWithDerivedLiveness } from "./node-liveness.js";
import {
  type InterfaceReconcileSummary,
  reconcilePersistedInterfaces,
  reconcileSeedInterfaces,
} from "./node-inventory-reconcile.js";
import {
  nodeAudioDefaultsFromMetadata,
  nodeMetadata,
  nodeRecordingCapacityFromMetadata,
  nodeRuntimeFromInput,
  nodeRuntimeFromMetadata,
  numberArray,
  record,
  stringArray,
  stringOrUndefined,
} from "./node-metadata.js";
import { updatedNode, updatedNodeHeartbeat, updatedNodeInterface } from "./node-store-updates.js";

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
  audioDefaults?: NodeAudioCommandDefaults;
  recordingCapacity?: NodeRecordingCapacity;
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
  audioDefaults?: NodeAudioCommandDefaults;
  recordingCapacity?: NodeRecordingCapacity;
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

export interface NodeInventoryReconcileResult {
  node: RecorderNode;
  summary: InterfaceReconcileSummary;
}

export interface NodeCredentialAuth {
  credentialId: string;
  nodeId: string;
  tokenPrefix: string;
}

export class NodeStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "channel_not_found"
      | "database_unavailable"
      | "interface_not_found"
      | "node_not_found",
  ) {
    super(message);
  }
}

export interface ChannelRoomAssignment {
  channelIndex: number;
  interfaceId: string;
  roomId: string | null;
}

export interface NodeStore {
  /**
   * Assign (or clear, with roomId null) the owning room of specific channels on a
   * node. Assignments referencing an interface that does not belong to the node
   * are rejected. Returns the reloaded node, or undefined if the node is unknown.
   */
  assignChannelRooms(
    nodeId: string,
    assignments: ChannelRoomAssignment[],
  ): Promise<RecorderNode | undefined>;
  authenticateCredential(token: string): Promise<NodeCredentialAuth | undefined>;
  enroll(input: NodeEnrollmentInput, actorUserId?: string): Promise<NodeEnrollmentResult>;
  find(nodeId: string): Promise<RecorderNode | undefined>;
  heartbeat(nodeId: string, input: NodeHeartbeatInput): Promise<RecorderNode | undefined>;
  list(): Promise<RecorderNode[]>;
  /** Reconcile the node's audio interfaces from the agent's discovered inventory. */
  reconcileInterfaces(
    nodeId: string,
    interfaces: NodeInterfaceInput[],
  ): Promise<NodeInventoryReconcileResult | undefined>;
  rotateCredential(nodeId: string, actorUserId?: string): Promise<NodeEnrollmentResult | undefined>;
  /** Idempotently persist seed nodes as real enrolled rows (no-op without a database). */
  seed(nodes: RecorderNode[]): Promise<void>;
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

  async assignChannelRooms(nodeId: string, assignments: ChannelRoomAssignment[]) {
    const index = this.seedNodes.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      return undefined;
    }

    const node = this.seedNodes[index];

    assertAssignmentsBelongToNode(node, assignments);

    const roomByChannel = channelRoomAssignmentMap(assignments);

    this.seedNodes[index] = {
      ...node,
      interfaces: node.interfaces.map((audioInterface) => ({
        ...audioInterface,
        channels: audioInterface.channels.map((channel) => {
          const key = channelAssignmentKey(audioInterface.id, channel.index);

          return roomByChannel.has(key)
            ? { ...channel, roomId: roomByChannel.get(key) ?? undefined }
            : channel;
        }),
      })),
    };

    return this.seedNodes[index];
  }

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

  async reconcileInterfaces(nodeId: string, interfaces: NodeInterfaceInput[]) {
    const index = this.seedNodes.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      return undefined;
    }

    const { interfaces: nextInterfaces, summary } = reconcileSeedInterfaces(
      this.seedNodes[index].interfaces,
      interfaces,
    );

    this.seedNodes[index] = { ...this.seedNodes[index], interfaces: nextInterfaces };

    return { node: this.seedNodes[index], summary };
  }

  async rotateCredential(): Promise<NodeEnrollmentResult> {
    throw new NodeStoreError("Node credential rotation requires Postgres", "database_unavailable");
  }

  async seed() {
    // Seed nodes are already the in-memory source of truth here.
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

type NodeDatabase = ReturnType<typeof createDatabase>;
// The db handle or a transaction handle — both expose the query builders
// createCredential needs, so it can run inside rotateCredential's transaction.
type NodeDbExecutor = NodeDatabase | Parameters<Parameters<NodeDatabase["transaction"]>[0]>[0];

class PostgresNodeStore implements NodeStore {
  private dbAvailable = true;
  private readonly db: NodeDatabase;

  constructor(
    databaseUrl: string,
    private readonly seedNodes: RecorderNode[],
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async assignChannelRooms(nodeId: string, assignments: ChannelRoomAssignment[]) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node channel storage is unavailable", "database_unavailable");
    }

    const node = await this.find(nodeId);

    if (!node) {
      return undefined;
    }

    assertAssignmentsBelongToNode(node, assignments);

    for (const assignment of assignments) {
      await db
        .update(audioChannels)
        .set({ roomId: assignment.roomId })
        .where(
          and(
            eq(audioChannels.interfaceId, assignment.interfaceId),
            eq(audioChannels.index, assignment.channelIndex),
          ),
        );
    }

    return this.find(nodeId);
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

    // heartbeat() and update() both read-modify-write the metadata JSONB. Under a
    // plain read-then-write, a concurrent operator update() and a (frequent) agent
    // heartbeat() race: the later writer clobbers the other's metadata changes
    // (last-writer-wins), silently reverting e.g. an operator's audioDefaults edit.
    // Lock the row for the read-modify-write so the two serialize per node.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(nodeRows).where(eq(nodeRows.id, nodeId)).for("update");

      if (!row) {
        return false;
      }

      await tx
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

      return true;
    });

    return updated ? this.find(nodeId) : undefined;
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

  async reconcileInterfaces(nodeId: string, interfaces: NodeInterfaceInput[]) {
    const db = this.availableDatabase();

    if (!db) {
      throw new NodeStoreError("Node inventory storage is unavailable", "database_unavailable");
    }

    const [node] = await db
      .select({ id: nodeRows.id })
      .from(nodeRows)
      .where(eq(nodeRows.id, nodeId))
      .limit(1);

    if (!node) {
      return undefined;
    }

    try {
      const summary = await reconcilePersistedInterfaces(db, nodeId, interfaces);
      const reconciled = await this.find(nodeId);

      if (!reconciled) {
        throw new NodeStoreError("Reconciled node could not be loaded", "node_not_found");
      }

      return { node: reconciled, summary };
    } catch (error) {
      this.markUnavailable(error);
      throw error;
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

    // Revoke prior credential(s) + issue the new one ATOMICALLY: a failed insert
    // after the revoke would leave the node with zero active credentials (locked
    // out), and concurrent rotations could both insert an active row. The
    // transaction + `node_credentials_active_node_idx` partial unique index keep
    // exactly one active credential — a failed/racing rotation rolls back.
    const credential = await db.transaction(async (tx) => {
      await tx
        .update(nodeCredentials)
        .set({ revokedAt: new Date() })
        .where(and(eq(nodeCredentials.nodeId, nodeId), isNull(nodeCredentials.revokedAt)));

      return this.createCredential(nodeId, actorUserId, tx);
    });

    return {
      credential,
      node: (await this.find(nodeId)) ?? nodeFromRows(node, [], []),
    };
  }

  async seed(nodesToSeed: RecorderNode[]) {
    const db = this.availableDatabase();

    if (!db) {
      return;
    }

    try {
      for (const node of nodesToSeed) {
        const [existing] = await db
          .select({ id: nodeRows.id })
          .from(nodeRows)
          .where(eq(nodeRows.id, node.id))
          .limit(1);

        if (existing) {
          continue;
        }

        await db.insert(nodeRows).values(recorderNodeToRow(node));

        for (const audioInterface of node.interfaces) {
          await db.insert(audioInterfaces).values(recorderInterfaceToRow(node.id, audioInterface));

          if (audioInterface.channels.length > 0) {
            await db.insert(audioChannels).values(
              audioInterface.channels.map((channel) => ({
                alias: channel.alias,
                index: channel.index,
                interfaceId: audioInterface.id,
              })),
            );
          }
        }
      }
    } catch (error) {
      this.markUnavailable(error);
    }
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

    // Lock the row for the read-modify-write so a concurrent heartbeat() cannot
    // clobber this operator update's metadata changes (and vice versa) — see the
    // heartbeat() note. The two serialize per node.
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(nodeRows).where(eq(nodeRows.id, nodeId)).for("update");

      if (!row) {
        return false;
      }

      const existing = nodeFromRows(row, [], []);
      const next = updatedNode(existing, input);

      await tx
        .update(nodeRows)
        .set({
          alias: next.alias,
          hostname: next.hostname,
          location: next.location,
          metadata: nodeMetadata(
            row.metadata,
            next.runtime,
            next.recordingCapacity,
            next.audioDefaults,
          ),
          network: { ipAddresses: next.ipAddresses },
          notes: next.notes ?? null,
          tags: next.tags,
          updatedAt: new Date(),
        })
        .where(eq(nodeRows.id, nodeId));

      return true;
    });

    return updated ? this.find(nodeId) : undefined;
  }

  private async createCredential(
    nodeId: string,
    actorUserId?: string,
    executor: NodeDbExecutor = this.db,
  ) {
    const token = `rakkr_node_${randomBytes(32).toString("base64url")}`;
    const [row] = await executor
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

function recorderNodeToRow(node: RecorderNode): typeof nodeRows.$inferInsert {
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

function recorderInterfaceToRow(
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

function seedNodesEnabled() {
  return process.env.RAKKR_SEED_DEMO_DATA !== "0";
}
