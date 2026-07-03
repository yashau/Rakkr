import { accessPolicies as accessPolicyRows, createDatabase } from "@rakkr/db";

import type {
  AccessPolicy,
  AccessPolicyDecision,
  AccessPolicyInput,
  CurrentUser,
} from "./auth-types.js";
import {
  accessPoliciesWithIds,
  isUuid,
  localAccessPoliciesFromEnv,
  policyMatchesSubject,
  policyMatchesTarget,
  uniqueAccessPolicyInputs,
} from "./auth-utils.js";

type Database = ReturnType<typeof createDatabase>;

// Dependencies the access-policy manager borrows from LocalAuthService. The
// override cache lives on the service (it is also read/written by group delete,
// see auth-group-manager.ts), so the manager reads and replaces it through these
// callbacks rather than owning it.
export interface AccessPolicyManagerDeps {
  availableDatabase(): Database | undefined;
  getAccessPolicyOverrides(): AccessPolicyInput[] | undefined;
  setAccessPolicyOverrides(policies: AccessPolicyInput[]): void;
  markDatabaseUnavailable(error: unknown): void;
}

// First-party resource access policies (allow/deny by subject × target). In DB
// mode `access_policies` is the source of truth; an in-memory override cache (also
// used by env-seeded policies and by tests) stands in without a DB. Deny wins over
// a matching allow.
export class LocalAccessPolicyManager {
  constructor(private readonly deps: AccessPolicyManagerDeps) {}

  async list(): Promise<AccessPolicy[]> {
    const overrides = this.deps.getAccessPolicyOverrides();

    if (overrides) {
      return accessPoliciesWithIds(overrides);
    }

    const db = this.deps.availableDatabase();

    if (db) {
      try {
        const rows = await db.select().from(accessPolicyRows);

        if (rows.length > 0) {
          return rows.map((row) => ({
            effect: row.effect,
            id: row.id,
            reason: row.reason ?? undefined,
            resourceId: row.resourceId,
            resourceType: row.resourceType,
            subjectId: row.subjectId ?? undefined,
            subjectType: row.subjectType,
          }));
        }
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
      }
    }

    return localAccessPoliciesFromEnv();
  }

  async decision(
    user: CurrentUser,
    targets: Array<{ id?: string; type: string }>,
  ): Promise<AccessPolicyDecision | undefined> {
    const matchingPolicies = (await this.list()).filter(
      (policy) => policyMatchesSubject(policy, user) && policyMatchesTarget(policy, targets),
    );
    const deny = matchingPolicies.find((policy) => policy.effect === "deny");

    if (deny) {
      return { effect: "deny", policy: deny };
    }

    const allow = matchingPolicies.find((policy) => policy.effect === "allow");

    return allow ? { effect: "allow", policy: allow } : undefined;
  }

  async update(policies: AccessPolicyInput[], actorUserId?: string): Promise<AccessPolicy[]> {
    const nextPolicies = uniqueAccessPolicyInputs(policies);

    this.deps.setAccessPolicyOverrides(nextPolicies);

    const db = this.deps.availableDatabase();

    if (db) {
      try {
        await db.delete(accessPolicyRows);

        if (nextPolicies.length > 0) {
          await db.insert(accessPolicyRows).values(
            nextPolicies.map((policy) => ({
              createdByUserId: actorUserId && isUuid(actorUserId) ? actorUserId : undefined,
              effect: policy.effect,
              reason: policy.reason,
              resourceId: policy.resourceId,
              resourceType: policy.resourceType,
              subjectId: policy.subjectId,
              subjectType: policy.subjectType,
            })),
          );
        }
      } catch (error) {
        this.deps.markDatabaseUnavailable(error);
      }
    }

    return accessPoliciesWithIds(nextPolicies);
  }
}
