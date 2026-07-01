import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, eq, uploadPolicies as uploadPoliciesTable } from "@rakkr/db";
import { DatabaseUnavailableError } from "./database-unavailable.js";
import {
  defaultStubUploadPolicy,
  uploadPolicyInputSchema,
  uploadPolicySchema,
  uploadPolicyUpdateSchema,
  type RecordingSummary,
  type UploadDestinationRuntimeStatus,
  type UploadPolicy,
  type UploadPolicyInput,
  type UploadPolicyUpdate,
} from "@rakkr/shared";
import type { UploadDestinationStore } from "./upload-destinations.js";

type UploadPolicyRow = typeof uploadPoliciesTable.$inferSelect;

const policyStorePath = path.resolve(
  process.env.RAKKR_UPLOAD_POLICY_STORE_PATH ?? "data/upload-policies.json",
);

interface UploadPolicyStore {
  create(input: UploadPolicyInput): Promise<UploadPolicy>;
  find(policyId: string | undefined): Promise<UploadPolicy | undefined>;
  list(): Promise<UploadPolicy[]>;
  update(policyId: string, input: UploadPolicyUpdate): Promise<UploadPolicy | undefined>;
}

class JsonUploadPolicyStore implements UploadPolicyStore {
  private readonly policies = loadUploadPolicies();

  async list() {
    return [...this.policies].sort((left, right) => left.name.localeCompare(right.name));
  }

  async find(policyId: string | undefined) {
    return this.policies.find((policy) => policy.id === policyId);
  }

  async create(input: UploadPolicyInput) {
    const parsed = uploadPolicyInputSchema.parse(input);
    const now = new Date().toISOString();
    const policy = uploadPolicySchema.parse({
      ...parsed,
      id: parsed.id ?? `upload_policy_${randomUUID()}`,
      updatedAt: now,
    });

    this.policies.unshift(policy);
    this.persist();

    return policy;
  }

  async update(policyId: string, input: UploadPolicyUpdate) {
    const update = uploadPolicyUpdateSchema.parse(input);
    const index = this.policies.findIndex((policy) => policy.id === policyId);

    if (index < 0) {
      return undefined;
    }

    const updated = uploadPolicySchema.parse({
      ...this.policies[index],
      ...update,
      id: policyId,
      updatedAt: new Date().toISOString(),
    });

    this.policies[index] = updated;
    this.persist();

    return updated;
  }

  private persist() {
    mkdirSync(path.dirname(policyStorePath), { recursive: true });
    const tempPath = `${policyStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        policies: this.policies,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, policyStorePath);
  }
}

class PostgresUploadPolicyStore implements UploadPolicyStore {
  private dbAvailable = true;
  private readonly db;

  constructor(private readonly fallback: UploadPolicyStore) {
    this.db = createDatabase(process.env.DATABASE_URL!);
  }

  async list() {
    if (!this.dbAvailable) {
      return this.fallback.list();
    }

    try {
      const rows = await this.db.select().from(uploadPoliciesTable);
      const byId = new Map<string, UploadPolicy>([
        [defaultStubUploadPolicy.id, defaultStubUploadPolicy],
      ]);

      for (const row of rows) {
        byId.set(row.id, policyFromRow(row));
      }

      return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      await this.failover("upload policy query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async find(policyId: string | undefined) {
    if (!policyId) {
      return undefined;
    }

    if (!this.dbAvailable) {
      return this.fallback.find(policyId);
    }

    try {
      return await this.findExisting(policyId);
    } catch (error) {
      await this.failover("upload policy lookup unavailable; using JSON store", error);
      return this.fallback.find(policyId);
    }
  }

  async create(input: UploadPolicyInput) {
    if (!this.dbAvailable) {
      return this.fallback.create(input);
    }

    try {
      const parsed = uploadPolicyInputSchema.parse(input);
      const policy = uploadPolicySchema.parse({
        ...parsed,
        id: parsed.id ?? `upload_policy_${randomUUID()}`,
        updatedAt: new Date().toISOString(),
      });

      await this.writePolicy(policy);

      return policy;
    } catch (error) {
      await this.failover("upload policy create unavailable; using JSON store", error);
      return this.fallback.create(input);
    }
  }

  async update(policyId: string, input: UploadPolicyUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(policyId, input);
    }

    try {
      const existing = await this.findExisting(policyId);

      if (!existing) {
        return undefined;
      }

      const updated = uploadPolicySchema.parse({
        ...existing,
        ...uploadPolicyUpdateSchema.parse(input),
        id: policyId,
        updatedAt: new Date().toISOString(),
      });

      await this.writePolicy(updated);

      return updated;
    } catch (error) {
      await this.failover("upload policy update unavailable; using JSON store", error);
      return this.fallback.update(policyId, input);
    }
  }

  private async findExisting(policyId: string) {
    const [row] = await this.db
      .select()
      .from(uploadPoliciesTable)
      .where(eq(uploadPoliciesTable.id, policyId))
      .limit(1);

    if (row) {
      return policyFromRow(row);
    }

    return policyId === defaultStubUploadPolicy.id ? defaultStubUploadPolicy : undefined;
  }

  private async writePolicy(policy: UploadPolicy) {
    await this.db
      .insert(uploadPoliciesTable)
      .values(policyToRow(policy))
      .onConflictDoUpdate({
        set: {
          deleteCacheAfterUpload: policy.deleteCacheAfterUpload,
          destinationId: policy.destinationId ?? null,
          enabled: policy.enabled,
          maxAttempts: policy.maxAttempts,
          name: policy.name,
          pathOverride: policy.pathOverride ?? null,
          trigger: policy.trigger,
          updatedAt: new Date(policy.updatedAt),
        },
        target: uploadPoliciesTable.id,
      });
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }
}

function createUploadPolicyStore() {
  const fallback = new JsonUploadPolicyStore();

  return process.env.DATABASE_URL ? new PostgresUploadPolicyStore(fallback) : fallback;
}

const uploadPolicyStore = createUploadPolicyStore();

export function listUploadPolicies() {
  return uploadPolicyStore.list();
}

export function findUploadPolicy(policyId: string | undefined) {
  return uploadPolicyStore.find(policyId);
}

export function createUploadPolicy(input: UploadPolicyInput) {
  return uploadPolicyStore.create(input);
}

export function updateUploadPolicy(policyId: string, input: UploadPolicyUpdate) {
  return uploadPolicyStore.update(policyId, input);
}

export async function uploadPolicyForQueue(policyId: string | undefined) {
  return (await findUploadPolicy(policyId)) ?? defaultStubUploadPolicy;
}

// All enabled `on_recording_cached` policies attached to a cached recording. The
// upload runner fans out one independent queue item per returned policy.
export async function uploadPoliciesForCachedRecording(recording: RecordingSummary) {
  if (!recording.cached || recording.status !== "cached") {
    return [];
  }

  return uploadPoliciesForChunkedRecording(recording);
}

// Enabled `on_recording_cached` policies attached to a recording, regardless of
// its current status. Chunked recordings enqueue uploads per chunk as each chunk
// closes — before the recording itself is marked cached.
export async function uploadPoliciesForChunkedRecording(recording: RecordingSummary) {
  const policies: UploadPolicy[] = [];

  for (const policyId of recording.uploadPolicyIds ?? []) {
    const policy = await findUploadPolicy(policyId);

    if (policy && policy.enabled && policy.trigger === "on_recording_cached") {
      policies.push(policy);
    }
  }

  return policies;
}

// Back-compat singular helper retained for baseline checks; prefer the plural.
export async function uploadPolicyForCachedRecording(recording: RecordingSummary) {
  return (await uploadPoliciesForCachedRecording(recording))[0];
}

export async function uploadQueueInputForPolicy(
  policy: UploadPolicy,
  destinationStore: UploadDestinationStore,
  reason?: string,
) {
  if (!policy.destinationId) {
    return {
      maxAttempts: policy.maxAttempts,
      policyId: policy.id,
      provider: "stub" as const,
      reason,
    };
  }

  const destination = await destinationStore.find(policy.destinationId);

  return {
    destinationId: policy.destinationId,
    maxAttempts: policy.maxAttempts,
    pathOverride: policy.pathOverride,
    policyId: policy.id,
    // The kind drives the executor branch; a missing destination keeps a non-stub
    // value so the executor fails visibly with destination_not_found.
    provider: destination?.kind ?? "s3",
    reason,
    target: destinationDisplayTarget(destination, policy.pathOverride),
  };
}

function destinationDisplayTarget(
  destination: UploadDestinationRuntimeStatus | undefined,
  pathOverride: string | undefined,
) {
  if (!destination?.target) {
    return undefined;
  }

  return pathOverride
    ? `${destination.target}/${pathOverride.replace(/^\/+/, "")}`
    : destination.target;
}

function loadUploadPolicies() {
  const policies = existsSync(policyStorePath) ? readUploadPolicies() : [];
  const byId = new Map<string, UploadPolicy>([
    [defaultStubUploadPolicy.id, defaultStubUploadPolicy],
  ]);

  for (const policy of policies) {
    byId.set(policy.id, policy);
  }

  return [...byId.values()];
}

function readUploadPolicies() {
  const raw = readFileSync(policyStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const policies = isPolicyStore(parsed) ? parsed.policies : parsed;

  if (!Array.isArray(policies)) {
    throw new Error("upload_policy_store_invalid");
  }

  return policies.map((policy) => uploadPolicySchema.parse(policy));
}

function isPolicyStore(value: unknown): value is { policies: unknown[] } {
  return typeof value === "object" && value !== null && "policies" in value;
}

function policyFromRow(row: UploadPolicyRow): UploadPolicy {
  return uploadPolicySchema.parse({
    deleteCacheAfterUpload: row.deleteCacheAfterUpload,
    destinationId: row.destinationId ?? undefined,
    enabled: row.enabled,
    id: row.id,
    maxAttempts: row.maxAttempts,
    name: row.name,
    pathOverride: row.pathOverride ?? undefined,
    trigger: row.trigger,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function policyToRow(policy: UploadPolicy) {
  return {
    deleteCacheAfterUpload: policy.deleteCacheAfterUpload,
    destinationId: policy.destinationId ?? null,
    enabled: policy.enabled,
    id: policy.id,
    maxAttempts: policy.maxAttempts,
    name: policy.name,
    pathOverride: policy.pathOverride ?? null,
    trigger: policy.trigger,
    updatedAt: new Date(policy.updatedAt),
  };
}
