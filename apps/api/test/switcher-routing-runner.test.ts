import assert from "node:assert/strict";
import test from "node:test";

import type { ScheduleSummary } from "@rakkr/shared";

import type { ScheduleStore } from "../src/schedule-store.js";
import type {
  StoredSwitcherMappings,
  SwitcherMappingStore,
} from "../src/switcher-mapping-store.js";
import type {
  ResolvedSwitcherConnection,
  SwitcherStatus,
  SwitcherStore,
} from "../src/switcher-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const {
  buildGroupMembership,
  computeActiveRoomUsers,
  computeDesiredRoutes,
  diffRoutes,
  runSwitcherReconcile,
  scheduleActiveAt,
} = await import("../src/switcher-routing-runner.js");
type SwitcherGateway = import("../src/switcher-routing-runner.js").SwitcherGateway;
type SwitcherRoutingRunnerDependencies =
  import("../src/switcher-routing-runner.js").SwitcherRoutingRunnerDependencies;

const now = new Date("2026-07-03T12:00:00.000Z");

function schedule(overrides: Partial<ScheduleSummary>): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    enabled: true,
    folderTemplate: "folder",
    id: "sch",
    name: "Schedule",
    nodeId: "node",
    recurrence: { mode: "manual" },
    recordingProfileId: "profile",
    retentionPolicyId: "retention",
    room: "Room",
    roomId: "room_a",
    tags: [],
    timezone: "UTC",
    titleTemplate: "title",
    uploadPolicyIds: [],
    watchdogPolicyId: "watchdog",
    ...overrides,
  };
}

test("scheduleActiveAt reflects always_on, manual, disabled, and timed windows", () => {
  assert.equal(scheduleActiveAt(schedule({ recurrence: { mode: "always_on" } }), now), true);
  assert.equal(scheduleActiveAt(schedule({ recurrence: { mode: "manual" } }), now), false);
  assert.equal(
    scheduleActiveAt(schedule({ enabled: false, recurrence: { mode: "always_on" } }), now),
    false,
  );

  const covering = schedule({
    recurrence: { endTime: "13:00", interval: 1, mode: "daily", startTime: "11:00" },
  });
  assert.equal(scheduleActiveAt(covering, now), true);

  const notCovering = schedule({
    recurrence: { endTime: "15:00", interval: 1, mode: "daily", startTime: "14:00" },
  });
  assert.equal(scheduleActiveAt(notCovering, now), false);
});

test("computeActiveRoomUsers expands direct users and group members", () => {
  const membership = buildGroupMembership([
    { groupIds: ["group_hansard"], id: "user_a" },
    { groupIds: ["group_hansard"], id: "user_b" },
    { groupIds: [], id: "user_c" },
  ]);
  const schedules = [
    schedule({
      assignedGroupIds: ["group_hansard"],
      assignedUserIds: ["user_c"],
      id: "sch_live",
      recurrence: { mode: "always_on" },
      roomId: "room_a",
    }),
    schedule({ id: "sch_idle", recurrence: { mode: "manual" }, roomId: "room_b" }),
  ];

  const active = computeActiveRoomUsers(schedules, membership, now);

  assert.deepEqual([...(active.get("room_a") ?? [])].sort(), ["user_a", "user_b", "user_c"]);
  assert.equal(active.has("room_b"), false);
});

test("computeDesiredRoutes maps active room users to owned outputs and flags conflicts", () => {
  const mappings: StoredSwitcherMappings = {
    inputs: [
      { input: 5, roomId: "room_a" },
      { input: 9, roomId: "room_b" },
    ],
    outputs: [
      { output: 7, userId: "user_a" },
      { output: 8, userId: "user_b" },
      { output: 9, userId: "user_c" },
    ],
  };
  const active = new Map<string, Set<string>>([
    ["room_a", new Set(["user_a", "user_b"])],
    ["room_b", new Set(["user_b"])], // user_b is live in two rooms -> conflict
  ]);

  const { conflicts, desired } = computeDesiredRoutes(mappings, active);

  assert.equal(desired.get(7), 5); // user_a -> room_a input 5
  assert.equal(desired.get(8), 5); // conflict resolved to the lowest input (5 < 9)
  assert.equal(desired.has(9), false); // user_c has no live meeting -> output stays idle
  assert.deepEqual(conflicts, [{ candidates: [5, 9], output: 8 }]);
});

test("diffRoutes only changes owned outputs that differ, leaving idle ones alone", () => {
  const current = new Map<number, number>([
    [7, 9],
    [8, 9],
    [10, 3],
  ]);
  const desired = new Map<number, number>([
    [7, 5], // change
    [8, 9], // unchanged
  ]);

  assert.deepEqual(diffRoutes(current, desired), [{ from: 9, output: 7, to: 5 }]);
});

const switcher: SwitcherStatus = {
  createdAt: "2026-07-03T00:00:00.000Z",
  displayName: "Hansard Matrix",
  enabled: true,
  hasPassword: false,
  host: "172.22.195.101",
  id: "sw1",
  inputs: 24,
  mode: "enforce",
  model: "avpro-ac-max",
  outputs: 24,
  port: 23,
  updatedAt: "2026-07-03T00:00:00.000Z",
};

function resolved(mode: SwitcherStatus["mode"]): ResolvedSwitcherConnection {
  return {
    displayName: switcher.displayName,
    enabled: true,
    host: switcher.host,
    id: switcher.id,
    inputs: 24,
    mode,
    model: "avpro-ac-max",
    outputs: 24,
    port: 23,
  };
}

function buildDeps(options: {
  gateway: SwitcherGateway;
  healthEventStore?: ReturnType<typeof createHealthEventStore>;
  mappings: StoredSwitcherMappings;
  mode: SwitcherStatus["mode"];
  schedules: ScheduleSummary[];
}): SwitcherRoutingRunnerDependencies {
  return {
    auditStore: createAuditStore(""),
    gateway: options.gateway,
    healthEventStore: options.healthEventStore,
    listUsers: async () => [
      { groupIds: [], id: "user_a" },
      { groupIds: [], id: "user_b" },
    ],
    scheduleStore: { list: async () => options.schedules } as unknown as ScheduleStore,
    switcherMappingStore: {
      get: async () => options.mappings,
    } as unknown as SwitcherMappingStore,
    switcherStore: {
      list: async () => [{ ...switcher, mode: options.mode }],
      resolveConfig: async () => resolved(options.mode),
    } as unknown as SwitcherStore,
  };
}

const routingMappings: StoredSwitcherMappings = {
  inputs: [{ input: 5, roomId: "room_a" }],
  outputs: [
    { output: 7, userId: "user_a" },
    { output: 8, userId: "user_b" },
  ],
};

const liveSchedules = [
  schedule({
    assignedUserIds: ["user_a"],
    id: "sch_live",
    recurrence: { mode: "always_on" },
    roomId: "room_a",
  }),
];

function memoryGateway(routes: Map<number, number>): SwitcherGateway {
  return {
    async runSession(_config, fn) {
      return fn({
        readRoutes: async () => new Map(routes),
        setRoute: async (output, input) => {
          routes.set(output, input);
          return input;
        },
      });
    },
  };
}

test("enforce mode applies owned-output changes and leaves idle outputs untouched", async () => {
  const routes = new Map<number, number>([
    [7, 9],
    [8, 9],
  ]);
  const deps = buildDeps({
    gateway: memoryGateway(routes),
    mappings: routingMappings,
    mode: "enforce",
    schedules: liveSchedules,
  });

  const [result] = await runSwitcherReconcile(deps, new Map(), now);

  assert.equal(result.applied, 1);
  assert.equal(result.planned, 1);
  assert.equal(routes.get(7), 5); // user_a's meeting routed to input 5
  assert.equal(routes.get(8), 9); // user_b idle -> left as-is
});

test("observe mode plans but never writes", async () => {
  const routes = new Map<number, number>([[7, 9]]);
  const deps = buildDeps({
    gateway: memoryGateway(routes),
    mappings: routingMappings,
    mode: "observe",
    schedules: liveSchedules,
  });

  const [result] = await runSwitcherReconcile(deps, new Map(), now);

  assert.equal(result.planned, 1);
  assert.equal(result.applied, 0);
  assert.equal(routes.get(7), 9); // unchanged in observe mode
});

test("opens an unreachable health event once and resolves it on recovery", async () => {
  const healthEventStore = createHealthEventStore("", []);
  let shouldFail = true;
  const gateway: SwitcherGateway = {
    async runSession(config, fn) {
      if (shouldFail) {
        throw new Error("connect ECONNREFUSED");
      }

      return fn({
        readRoutes: async () => new Map<number, number>([[7, 9]]),
        setRoute: async (_output, input) => input,
      });
    },
  };
  const deps = buildDeps({
    gateway,
    healthEventStore,
    mappings: routingMappings,
    mode: "enforce",
    schedules: liveSchedules,
  });
  const reachable = new Map<string, boolean>();

  await runSwitcherReconcile(deps, reachable, now);
  await runSwitcherReconcile(deps, reachable, now); // still failing -> no duplicate event

  const openAfterFailure = await healthEventStore.list({
    status: "open",
    type: "switcher.unreachable",
  });
  assert.equal(openAfterFailure.length, 1);

  shouldFail = false;
  await runSwitcherReconcile(deps, reachable, now); // recovery resolves the open event

  const stillOpen = await healthEventStore.list({ status: "open", type: "switcher.unreachable" });
  assert.equal(stillOpen.length, 0);
});
