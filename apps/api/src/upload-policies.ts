import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  defaultStubUploadPolicy,
  uploadPolicyInputSchema,
  uploadPolicySchema,
  uploadPolicyUpdateSchema,
  type UploadPolicy,
  type UploadPolicyInput,
  type UploadPolicyUpdate,
} from "@rakkr/shared";

const policyStorePath = path.resolve(
  process.env.RAKKR_UPLOAD_POLICY_STORE_PATH ?? "data/upload-policies.json",
);

class UploadPolicyStore {
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

const uploadPolicyStore = new UploadPolicyStore();

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
