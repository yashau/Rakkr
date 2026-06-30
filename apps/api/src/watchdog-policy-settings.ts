import { randomUUID } from "node:crypto";
import { watchdogPolicies as watchdogPoliciesTable } from "@rakkr/db";
import {
  defaultScheduledVoiceWatchdogPolicy,
  watchdogPolicySchema,
  type WatchdogPolicy,
} from "@rakkr/shared";

type WatchdogPolicyInsert = typeof watchdogPoliciesTable.$inferInsert;
type WatchdogPolicyRow = typeof watchdogPoliciesTable.$inferSelect;

// Body accepted by the create route/store: a name is required, every other rule
// is optional and falls back to the built-in scheduled-voice watchdog so
// operators can add a policy and then tune thresholds in the editor.
export type WatchdogPolicyCreateInput = Partial<Omit<WatchdogPolicy, "id">> &
  Pick<WatchdogPolicy, "name">;

export function watchdogPolicyFromInput(input: WatchdogPolicyCreateInput) {
  const { id: _unusedId, ...defaults } = defaultScheduledVoiceWatchdogPolicy;

  return watchdogPolicySchema.parse({
    ...defaults,
    ...input,
    id: `watchdog_policy_${randomUUID()}`,
  });
}

export function watchdogPolicyToRow(policy: WatchdogPolicy): WatchdogPolicyInsert {
  const { id, name, ...rules } = policy;

  return {
    id,
    name,
    rules,
  };
}

export function watchdogPolicyFromRow(row: WatchdogPolicyRow): WatchdogPolicy {
  const rules = recordOrEmpty(row.rules);

  return watchdogPolicySchema.parse({
    ...defaultScheduledVoiceWatchdogPolicy,
    ...rules,
    id: row.id,
    name: row.name,
  });
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
