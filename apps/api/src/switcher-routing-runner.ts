import { randomUUID } from "node:crypto";

import type { AuditEvent, ScheduleSummary } from "@rakkr/shared";

import type { AuditStore } from "./audit-store.js";
import type { HealthEventStore } from "./health-store.js";
import { reportRunnerTickError } from "./runner-tick.js";
import { windowScheduleOccurrences } from "./schedule-engine.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { StoredSwitcherMappings, SwitcherMappingStore } from "./switcher-mapping-store.js";
import type { ResolvedSwitcherConnection, SwitcherStore } from "./switcher-store.js";
import type { RouteMap } from "./switchers/index.js";
import {
  getSwitcherDriver,
  withSwitcherSession,
  type SwitcherConnection,
} from "./switchers/index.js";

// How far back to scan for an occurrence that started earlier but is still
// within its recording window right now. Covers meetings up to ~26h long.
const DEFAULT_LOOKBACK_MS = 26 * 60 * 60 * 1_000;
const UNREACHABLE_EVENT_TYPE = "switcher.unreachable";

export interface RouteChange {
  from: number;
  output: number;
  to: number;
}

export interface RouteConflict {
  candidates: number[];
  output: number;
}

export interface UserGroupMembership {
  groupIds: string[];
  id: string;
}

// Session-scoped device I/O seam. The default implementation opens one TCP
// session per switcher per pass; tests inject an in-memory gateway.
export interface SwitcherGateway {
  runSession<T>(
    config: ResolvedSwitcherConnection,
    fn: (ops: {
      readRoutes(): Promise<RouteMap>;
      setRoute(output: number, input: number): Promise<number>;
    }) => Promise<T>,
  ): Promise<T>;
}

const sessionOptions = { commandTimeoutMs: 8_000, connectTimeoutMs: 6_000, idleMs: 300 };

function connectionFor(config: ResolvedSwitcherConnection): SwitcherConnection {
  return {
    host: config.host,
    password: config.password,
    port: config.port,
    username: config.username,
  };
}

function defaultGateway(): SwitcherGateway {
  return {
    runSession(config, fn) {
      const driver = getSwitcherDriver(config.model);

      return withSwitcherSession(connectionFor(config), sessionOptions, (session) =>
        fn({
          readRoutes: () => driver.readRoutes(session),
          setRoute: (output, input) => driver.setRoute(session, output, input),
        }),
      );
    },
  };
}

// Is a schedule within a live recording window right now? always_on is always
// live; manual has no time-based window (routing follows scheduled meetings);
// timed recurrences are live between an occurrence's recording start and end.
export function scheduleActiveAt(
  schedule: ScheduleSummary,
  now: Date,
  lookbackMs = DEFAULT_LOOKBACK_MS,
): boolean {
  if (!schedule.enabled) {
    return false;
  }

  const mode = schedule.recurrence.mode;

  if (mode === "always_on") {
    return true;
  }

  if (mode === "manual") {
    return false;
  }

  const occurrences = windowScheduleOccurrences(
    schedule,
    new Date(now.getTime() - lookbackMs),
    new Date(now.getTime() + 1_000),
  );

  return occurrences.some((occurrence) => {
    const start = Date.parse(occurrence.recordingStartAt);

    if (!Number.isFinite(start) || start > now.getTime()) {
      return false;
    }

    if (!occurrence.recordingEndAt) {
      return true;
    }

    const end = Date.parse(occurrence.recordingEndAt);

    return !Number.isFinite(end) || now.getTime() <= end;
  });
}

export function buildGroupMembership(users: UserGroupMembership[]): Map<string, Set<string>> {
  const membership = new Map<string, Set<string>>();

  for (const user of users) {
    for (const groupId of user.groupIds) {
      const members = membership.get(groupId) ?? new Set<string>();

      members.add(user.id);
      membership.set(groupId, members);
    }
  }

  return membership;
}

// roomId -> set of user ids with a live meeting in that room right now
// (direct schedule assignees plus members of assigned groups).
export function computeActiveRoomUsers(
  schedules: ScheduleSummary[],
  groupMembership: Map<string, Set<string>>,
  now: Date,
): Map<string, Set<string>> {
  const roomUsers = new Map<string, Set<string>>();

  for (const schedule of schedules) {
    if (!schedule.roomId || !scheduleActiveAt(schedule, now)) {
      continue;
    }

    const users = roomUsers.get(schedule.roomId) ?? new Set<string>();

    for (const userId of schedule.assignedUserIds) {
      users.add(userId);
    }

    for (const groupId of schedule.assignedGroupIds) {
      for (const userId of groupMembership.get(groupId) ?? []) {
        users.add(userId);
      }
    }

    roomUsers.set(schedule.roomId, users);
  }

  return roomUsers;
}

// The routes the controller wants right now: for each mapped output whose user
// has a live meeting in a mapped room, route that output to the room's input.
// If a user is live in more than one mapped room, the lowest input wins and the
// clash is reported as a conflict. Outputs with no live meeting are absent (the
// caller leaves them as-is).
export function computeDesiredRoutes(
  mappings: StoredSwitcherMappings,
  activeRoomUsers: Map<string, Set<string>>,
): { conflicts: RouteConflict[]; desired: Map<number, number> } {
  const inputForRoom = new Map(mappings.inputs.map((entry) => [entry.roomId, entry.input]));
  const outputForUser = new Map(mappings.outputs.map((entry) => [entry.userId, entry.output]));
  const candidatesByOutput = new Map<number, Set<number>>();

  for (const [roomId, userIds] of activeRoomUsers) {
    const input = inputForRoom.get(roomId);

    if (input === undefined) {
      continue;
    }

    for (const userId of userIds) {
      const output = outputForUser.get(userId);

      if (output === undefined) {
        continue;
      }

      const candidates = candidatesByOutput.get(output) ?? new Set<number>();

      candidates.add(input);
      candidatesByOutput.set(output, candidates);
    }
  }

  const desired = new Map<number, number>();
  const conflicts: RouteConflict[] = [];

  for (const [output, inputs] of candidatesByOutput) {
    const sorted = [...inputs].sort((left, right) => left - right);

    desired.set(output, sorted[0]);

    if (sorted.length > 1) {
      conflicts.push({ candidates: sorted, output });
    }
  }

  return { conflicts, desired };
}

// Only outputs the controller owns (present in `desired`) are diffed. Idle
// owned outputs are absent from `desired`, so they are never changed.
export function diffRoutes(current: RouteMap, desired: Map<number, number>): RouteChange[] {
  const changes: RouteChange[] = [];

  for (const [output, input] of desired) {
    const from = current.get(output) ?? 0;

    if (from !== input) {
      changes.push({ from, output, to: input });
    }
  }

  return changes.sort((left, right) => left.output - right.output);
}

export interface SwitcherRoutingRunnerDependencies {
  auditStore: AuditStore;
  gateway?: SwitcherGateway;
  healthEventStore?: HealthEventStore;
  listUsers: () => Promise<UserGroupMembership[]>;
  scheduleStore: ScheduleStore;
  switcherMappingStore: SwitcherMappingStore;
  switcherStore: SwitcherStore;
}

export interface SwitcherReconcileResult {
  applied: number;
  conflicts: number;
  error?: string;
  mode: string;
  planned: number;
  switcherId: string;
}

export async function runSwitcherReconcile(
  dependencies: SwitcherRoutingRunnerDependencies,
  reachable: Map<string, boolean>,
  now = new Date(),
): Promise<SwitcherReconcileResult[]> {
  const gateway = dependencies.gateway ?? defaultGateway();
  const [schedules, users] = await Promise.all([
    dependencies.scheduleStore.list(),
    dependencies.listUsers(),
  ]);
  const activeRoomUsers = computeActiveRoomUsers(schedules, buildGroupMembership(users), now);
  const results: SwitcherReconcileResult[] = [];

  for (const switcher of await dependencies.switcherStore.list()) {
    if (!switcher.enabled || switcher.mode === "disabled") {
      continue;
    }

    const config = await dependencies.switcherStore.resolveConfig(switcher.id);

    if (!config) {
      continue;
    }

    const mappings = await dependencies.switcherMappingStore.get(switcher.id);

    // No owned outputs -> nothing for the controller to drive on this switcher.
    if (mappings.outputs.length === 0) {
      continue;
    }

    const { conflicts, desired } = computeDesiredRoutes(mappings, activeRoomUsers);

    try {
      const outcome = await gateway.runSession(config, async (ops) => {
        const current = await ops.readRoutes();
        const changes = diffRoutes(current, desired);
        const applied: RouteChange[] = [];

        if (config.mode === "enforce") {
          for (const change of changes) {
            await ops.setRoute(change.output, change.to);
            applied.push(change);
          }
        }

        return { applied, changes };
      });

      await markReachable(dependencies, switcher.id, now);
      await appendReconcileAudit(dependencies.auditStore, {
        action:
          config.mode === "enforce"
            ? "switchers.reconcile.succeeded"
            : "switchers.reconcile.observed",
        details: {
          applied: outcome.applied,
          appliedCount: outcome.applied.length,
          conflicts,
          mode: config.mode,
          ownedOutputs: mappings.outputs.length,
          plannedChanges: outcome.changes,
        },
        outcome: "succeeded",
        switcher,
      });
      results.push({
        applied: outcome.applied.length,
        conflicts: conflicts.length,
        mode: config.mode,
        planned: outcome.changes.length,
        switcherId: switcher.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "switcher_reconcile_failed";

      await markUnreachable(dependencies, switcher.id, config.host, message, now, reachable);
      await appendReconcileAudit(dependencies.auditStore, {
        action: "switchers.reconcile.failed",
        details: { host: config.host, mode: config.mode },
        outcome: "failed",
        reason: message,
        switcher,
      });
      results.push({
        applied: 0,
        conflicts: conflicts.length,
        error: message,
        mode: config.mode,
        planned: 0,
        switcherId: switcher.id,
      });
    }
  }

  return results;

  async function markReachable(
    deps: SwitcherRoutingRunnerDependencies,
    switcherId: string,
    at: Date,
  ) {
    if (reachable.get(switcherId) === false && deps.healthEventStore) {
      const open = await deps.healthEventStore.list({
        status: "open",
        type: UNREACHABLE_EVENT_TYPE,
      });

      for (const event of open) {
        if (event.details.switcherId === switcherId) {
          await deps.healthEventStore.updateLifecycle(event.id, {
            resolvedAt: at,
            resolvedBy: "system:switcher-router",
            status: "resolved",
          });
        }
      }
    }

    reachable.set(switcherId, true);
  }
}

async function markUnreachable(
  dependencies: SwitcherRoutingRunnerDependencies,
  switcherId: string,
  host: string,
  message: string,
  at: Date,
  reachable: Map<string, boolean>,
) {
  // Only open a health event on the transition into unreachable so a persistent
  // outage does not spawn one event per tick.
  if (reachable.get(switcherId) !== false && dependencies.healthEventStore) {
    await dependencies.healthEventStore.create({
      details: { error: message, host, switcherId },
      openedAt: at,
      severity: "warning",
      type: UNREACHABLE_EVENT_TYPE,
    });
  }

  reachable.set(switcherId, false);
}

export function createSwitcherRoutingRunner(dependencies: SwitcherRoutingRunnerDependencies) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const reachable = new Map<string, boolean>();

  async function tick(now = new Date()) {
    if (running) {
      return [];
    }

    running = true;

    try {
      return await runSwitcherReconcile(dependencies, reachable, now);
    } finally {
      running = false;
    }
  }

  return {
    async runOnce(now = new Date()) {
      return tick(now);
    },
    start(intervalMs = switcherRoutingRunnerIntervalMs()) {
      if (timer) {
        return;
      }

      timer = setInterval(() => {
        void tick().catch(reportRunnerTickError("switcher routing runner"));
      }, intervalMs);
      void tick().catch(reportRunnerTickError("switcher routing runner"));
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

async function appendReconcileAudit(
  auditStore: AuditStore,
  input: {
    action: string;
    details: Record<string, unknown>;
    outcome: AuditEvent["outcome"];
    reason?: string;
    switcher: { displayName: string; id: string };
  },
) {
  await auditStore.append({
    action: input.action,
    actor: {
      id: "system:switcher-router",
      name: "Rakkr Switcher Router",
      roles: [],
      type: "system",
    },
    actorContext: {},
    createdAt: new Date().toISOString(),
    details: input.details,
    id: `audit_${randomUUID()}`,
    outcome: input.outcome,
    permission: "switcher:manage",
    reason: input.reason,
    target: {
      id: input.switcher.id,
      name: input.switcher.displayName,
      type: "switcher",
    },
  });
}

function switcherRoutingRunnerIntervalMs() {
  const parsed = Number(process.env.RAKKR_SWITCHER_ROUTING_RUNNER_INTERVAL_SECONDS);

  return (Number.isInteger(parsed) && parsed > 0 ? parsed : 20) * 1_000;
}
