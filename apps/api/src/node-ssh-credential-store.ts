import { and, createDatabase, desc, eq, isNull, nodeSshCredentials } from "@rakkr/db";

import { isUuid } from "./auth-utils.js";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  fingerprintForOpensshPublicKey,
  generateSshKeyPair,
} from "./node-ssh-credential-crypto.js";

const DEFAULT_SSH_USERNAME = "rakkr";

export interface NodeSshCredentialMetadata {
  createdAt: string;
  fingerprint: string;
  id: string;
  nodeId: string;
  publicKey: string;
  rotatedAt?: string;
  username: string;
}

export interface NodeSshCredentialMaterial extends NodeSshCredentialMetadata {
  privateKey: string;
}

export class NodeSshCredentialStoreError extends Error {
  constructor(
    message: string,
    readonly code: "database_unavailable",
  ) {
    super(message);
  }
}

export interface NodeSshCredentialIngestInput {
  actorUserId?: string;
  privateKeyPem: string;
  publicKey: string;
  username?: string;
}

export interface NodeSshCredentialStore {
  findActiveMaterial(nodeId: string): Promise<NodeSshCredentialMaterial | undefined>;
  findActiveMetadata(nodeId: string): Promise<NodeSshCredentialMetadata | undefined>;
  /** Store a node-generated keypair (day-0 bootstrap), revoking any prior active key. */
  ingest(nodeId: string, input: NodeSshCredentialIngestInput): Promise<NodeSshCredentialMetadata>;
  rotate(
    nodeId: string,
    options?: { actorUserId?: string; username?: string },
  ): Promise<NodeSshCredentialMetadata>;
}

export function createNodeSshCredentialStore(
  databaseUrl = process.env.DATABASE_URL,
): NodeSshCredentialStore {
  return databaseUrl ? new PostgresNodeSshCredentialStore(databaseUrl) : new UnavailableStore();
}

class UnavailableStore implements NodeSshCredentialStore {
  async findActiveMaterial() {
    return undefined;
  }

  async findActiveMetadata() {
    return undefined;
  }

  async ingest(): Promise<NodeSshCredentialMetadata> {
    throw new NodeSshCredentialStoreError(
      "Node SSH credential storage requires Postgres",
      "database_unavailable",
    );
  }

  async rotate(): Promise<NodeSshCredentialMetadata> {
    throw new NodeSshCredentialStoreError(
      "Node SSH credential storage requires Postgres",
      "database_unavailable",
    );
  }
}

class PostgresNodeSshCredentialStore implements NodeSshCredentialStore {
  private readonly db;

  constructor(databaseUrl: string) {
    this.db = createDatabase(databaseUrl);
  }

  async rotate(nodeId: string, options: { actorUserId?: string; username?: string } = {}) {
    const previous = await this.activeRow(nodeId);
    const username = options.username?.trim() || previous?.username || DEFAULT_SSH_USERNAME;
    const keyPair = generateSshKeyPair(`rakkr-${nodeId}`);

    return this.persistActive(nodeId, {
      actorUserId: options.actorUserId,
      fingerprint: keyPair.fingerprint,
      privateKeyPem: keyPair.privateKeyPem,
      publicKey: keyPair.publicKeyOpenssh,
      username,
    });
  }

  async ingest(nodeId: string, input: NodeSshCredentialIngestInput) {
    const previous = await this.activeRow(nodeId);

    return this.persistActive(nodeId, {
      actorUserId: input.actorUserId,
      fingerprint: fingerprintForOpensshPublicKey(input.publicKey),
      privateKeyPem: input.privateKeyPem,
      publicKey: input.publicKey,
      username: input.username?.trim() || previous?.username || DEFAULT_SSH_USERNAME,
    });
  }

  private async persistActive(
    nodeId: string,
    input: {
      actorUserId?: string;
      fingerprint: string;
      privateKeyPem: string;
      publicKey: string;
      username: string;
    },
  ): Promise<NodeSshCredentialMetadata> {
    const now = new Date();

    // One active key per node: revoke any prior unrevoked credential, then insert
    // the new one — ATOMICALLY. Without the transaction a failed insert would
    // leave the node with every credential revoked and none active (no SSH
    // access); and two concurrent rotations could both insert an active row. The
    // revoke+insert runs in one transaction and the `node_ssh_credentials_active_node_idx`
    // partial unique index makes a racing second insert fail, rolling back that
    // whole rotation and preserving exactly one active credential.
    const [row] = await this.db.transaction(async (tx) => {
      await tx
        .update(nodeSshCredentials)
        .set({ revokedAt: now, rotatedAt: now })
        .where(and(eq(nodeSshCredentials.nodeId, nodeId), isNull(nodeSshCredentials.revokedAt)));

      return tx
        .insert(nodeSshCredentials)
        .values({
          createdByUserId:
            input.actorUserId && isUuid(input.actorUserId) ? input.actorUserId : null,
          fingerprint: input.fingerprint,
          nodeId,
          privateKeyEncrypted: encryptPrivateKey(input.privateKeyPem),
          publicKey: input.publicKey,
          username: input.username,
        })
        .returning({
          createdAt: nodeSshCredentials.createdAt,
          fingerprint: nodeSshCredentials.fingerprint,
          id: nodeSshCredentials.id,
          publicKey: nodeSshCredentials.publicKey,
          rotatedAt: nodeSshCredentials.rotatedAt,
          username: nodeSshCredentials.username,
        });
    });

    return {
      createdAt: row.createdAt.toISOString(),
      fingerprint: row.fingerprint,
      id: row.id,
      nodeId,
      publicKey: row.publicKey,
      rotatedAt: row.rotatedAt?.toISOString(),
      username: row.username,
    };
  }

  async findActiveMetadata(nodeId: string) {
    const row = await this.activeRow(nodeId);

    return row ? toMetadata(nodeId, row) : undefined;
  }

  async findActiveMaterial(nodeId: string) {
    const row = await this.activeRow(nodeId);

    if (!row) {
      return undefined;
    }

    return {
      ...toMetadata(nodeId, row),
      privateKey: decryptPrivateKey(row.privateKeyEncrypted),
    };
  }

  private async activeRow(nodeId: string) {
    const [row] = await this.db
      .select()
      .from(nodeSshCredentials)
      .where(and(eq(nodeSshCredentials.nodeId, nodeId), isNull(nodeSshCredentials.revokedAt)))
      .orderBy(desc(nodeSshCredentials.createdAt))
      .limit(1);

    return row;
  }
}

function toMetadata(
  nodeId: string,
  row: typeof nodeSshCredentials.$inferSelect,
): NodeSshCredentialMetadata {
  return {
    createdAt: row.createdAt.toISOString(),
    fingerprint: row.fingerprint,
    id: row.id,
    nodeId,
    publicKey: row.publicKey,
    rotatedAt: row.rotatedAt?.toISOString(),
    username: row.username,
  };
}
