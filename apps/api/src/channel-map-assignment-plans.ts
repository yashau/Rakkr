import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  channelMapAssignmentPlanInputSchema,
  channelMapAssignmentPlanSchema,
  type ChannelMapAssignmentPlan,
  type ChannelMapAssignmentPlanInput,
} from "@rakkr/shared";

const planStorePath = path.resolve(
  process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_PLAN_STORE_PATH ??
    "data/channel-map-assignment-plans.json",
);

export class ChannelMapAssignmentPlanStore {
  private readonly plans = loadPlans();

  async apply(planId: string, actorUserId?: string) {
    const index = this.plans.findIndex((plan) => plan.id === planId);
    const plan = this.plans[index];

    if (!plan || plan.status !== "pending") {
      return undefined;
    }

    const applied = channelMapAssignmentPlanSchema.parse({
      ...plan,
      appliedAt: new Date().toISOString(),
      appliedByUserId: actorUserId,
      status: "applied",
    });

    this.plans[index] = applied;
    this.persist();

    return applied;
  }

  async create(input: ChannelMapAssignmentPlanInput, actorUserId?: string) {
    const parsed = channelMapAssignmentPlanInputSchema.parse(input);
    const plan = channelMapAssignmentPlanSchema.parse({
      ...parsed,
      createdAt: new Date().toISOString(),
      createdByUserId: actorUserId,
      id: `channel_map_plan_${randomUUID()}`,
      status: "pending",
      targets: uniqueTargets(parsed.targets),
    });

    this.plans.unshift(plan);
    this.persist();

    return plan;
  }

  async find(planId: string) {
    return this.plans.find((plan) => plan.id === planId);
  }

  async list() {
    return [...this.plans].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private persist() {
    mkdirSync(path.dirname(planStorePath), { recursive: true });
    const tempPath = `${planStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        plans: this.plans,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, planStorePath);
  }
}

export function createChannelMapAssignmentPlanStore() {
  return new ChannelMapAssignmentPlanStore();
}

function loadPlans() {
  if (!existsSync(planStorePath)) {
    return [];
  }

  const raw = readFileSync(planStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const plans = isPlanStore(parsed) ? parsed.plans : parsed;

  if (!Array.isArray(plans)) {
    throw new Error("channel_map_assignment_plan_store_invalid");
  }

  return plans.map((plan) => channelMapAssignmentPlanSchema.parse(plan));
}

function isPlanStore(value: unknown): value is { plans: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { plans?: unknown }).plans)
  );
}

function uniqueTargets(targets: ChannelMapAssignmentPlan["targets"]) {
  const seen = new Set<string>();

  return targets.filter((target) => {
    const key = `${target.targetType}:${target.targetId}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
