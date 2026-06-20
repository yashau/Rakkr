import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  defaultKeepControllerCacheRetentionPolicy,
  retentionPolicyInputSchema,
  retentionPolicySchema,
  retentionPolicyUpdateSchema,
  type RetentionPolicy,
  type RetentionPolicyInput,
  type RetentionPolicyUpdate,
} from "@rakkr/shared";

const policyStorePath = path.resolve(
  process.env.RAKKR_RETENTION_POLICY_STORE_PATH ?? "data/retention-policies.json",
);

class RetentionPolicyStore {
  private readonly policies = loadRetentionPolicies();

  async list() {
    return [...this.policies].sort((left, right) => left.name.localeCompare(right.name));
  }

  async find(policyId: string | undefined) {
    return this.policies.find((policy) => policy.id === policyId);
  }

  async create(input: RetentionPolicyInput) {
    const parsed = retentionPolicyInputSchema.parse(input);
    const policy = retentionPolicySchema.parse({
      ...parsed,
      id: parsed.id ?? `retention_policy_${randomUUID()}`,
      updatedAt: new Date().toISOString(),
    });

    this.policies.unshift(policy);
    this.persist();

    return policy;
  }

  async update(policyId: string, input: RetentionPolicyUpdate) {
    const update = retentionPolicyUpdateSchema.parse(input);
    const index = this.policies.findIndex((policy) => policy.id === policyId);

    if (index < 0) {
      return undefined;
    }

    const updated = retentionPolicySchema.parse({
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

const retentionPolicyStore = new RetentionPolicyStore();

export function listRetentionPolicies() {
  return retentionPolicyStore.list();
}

export function findRetentionPolicy(policyId: string | undefined) {
  return retentionPolicyStore.find(policyId);
}

export function createRetentionPolicy(input: RetentionPolicyInput) {
  return retentionPolicyStore.create(input);
}

export function updateRetentionPolicy(policyId: string, input: RetentionPolicyUpdate) {
  return retentionPolicyStore.update(policyId, input);
}

function loadRetentionPolicies() {
  const policies = existsSync(policyStorePath) ? readRetentionPolicies() : [];
  const byId = new Map<string, RetentionPolicy>([
    [defaultKeepControllerCacheRetentionPolicy.id, defaultKeepControllerCacheRetentionPolicy],
  ]);

  for (const policy of policies) {
    byId.set(policy.id, policy);
  }

  return [...byId.values()];
}

function readRetentionPolicies() {
  const raw = readFileSync(policyStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const policies = isPolicyStore(parsed) ? parsed.policies : parsed;

  if (!Array.isArray(policies)) {
    throw new Error("retention_policy_store_invalid");
  }

  return policies.map((policy) => retentionPolicySchema.parse(policy));
}

function isPolicyStore(value: unknown): value is { policies: unknown[] } {
  return typeof value === "object" && value !== null && "policies" in value;
}
