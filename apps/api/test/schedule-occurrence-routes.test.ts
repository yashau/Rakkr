import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { ScheduleStore } from "../src/schedule-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-schedule-occurrence-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "recording-jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { registerScheduleRoutes } = await import("../src/schedule-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("calendar returns windowed occurrences for scoped, enabled schedules", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read"]);
  const daily = schedule({
    id: "sched_calendar_daily",
    name: "Daily Standup",
    recurrence: { endTime: "10:00", interval: 1, mode: "daily", startTime: "09:00" },
    room: "Studio A",
  });
  const disabled = schedule({
    enabled: false,
    id: "sched_calendar_disabled",
    name: "Retired",
    recurrence: { endTime: "10:00", interval: 1, mode: "daily", startTime: "09:00" },
  });

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: scheduleStore([daily, disabled]),
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [daily, disabled],
    settingsStore: createSettingsStore(),
  });

  const response = await app.request(
    "/api/v1/schedules/calendar?start=2026-06-15T00:00:00.000Z&end=2026-06-17T23:59:59.000Z",
  );
  const body = (await response.json()) as {
    data: Array<{
      recordingStartAt: string;
      recurrenceMode: string;
      room: string;
      scheduleId: string;
    }>;
    meta: { occurrenceCount: number; truncated: boolean };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 3);
  assert.ok(body.data.every((occurrence) => occurrence.scheduleId === "sched_calendar_daily"));
  assert.ok(body.data.every((occurrence) => occurrence.recurrenceMode === "daily"));
  assert.ok(body.data.every((occurrence) => occurrence.room === "Studio A"));
  assert.equal(body.meta.occurrenceCount, 3);
  assert.equal(body.meta.truncated, false);
});

test("calendar rejects an inverted window", async () => {
  const app = new Hono<AppBindings>();
  const currentUser = user(["schedule:read"]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: scheduleStore([]),
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [],
    settingsStore: createSettingsStore(),
  });

  const response = await app.request(
    "/api/v1/schedules/calendar?start=2026-06-17T00:00:00.000Z&end=2026-06-15T00:00:00.000Z",
  );
  const body = (await response.json()) as { reason: string };

  assert.equal(response.status, 400);
  assert.equal(body.reason, "end_before_start");
});

test("move-occurrence relocates a one-off in place", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:manage"]);
  const once = schedule({
    id: "sched_move_once",
    recurrence: { mode: "once", startsAt: "2026-06-20T14:00:00.000Z" },
  });

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: scheduleStore([once]),
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [once],
    settingsStore: createSettingsStore(),
  });

  const response = await requestJson(
    app,
    "/api/v1/schedules/sched_move_once/move-occurrence",
    "POST",
    { newStartAt: "2026-06-21T15:00:00.000Z", occurrenceStartAt: "2026-06-20T14:00:00.000Z" },
  );
  const body = (await response.json()) as { data: ScheduleSummary };

  assert.equal(response.status, 200);
  assert.equal(body.data.recurrence.mode, "once");
  assert.equal(
    body.data.recurrence.mode === "once" ? body.data.recurrence.startsAt : undefined,
    "2026-06-21T15:00:00.000Z",
  );
});

test("move-occurrence splits a recurring instance into a duration-preserving one-off", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:manage"]);
  const daily = schedule({
    assignedUserIds: ["user-vip"],
    id: "sched_move_daily",
    recurrence: { endTime: "10:00", interval: 1, mode: "daily", startTime: "09:00" },
  });
  const store = scheduleStore([daily]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const response = await requestJson(
    app,
    "/api/v1/schedules/sched_move_daily/move-occurrence",
    "POST",
    { newStartAt: "2026-06-15T14:00:00.000Z", occurrenceStartAt: "2026-06-15T09:00:00.000Z" },
  );
  const body = (await response.json()) as { data: ScheduleSummary; source: ScheduleSummary };

  assert.equal(response.status, 201);
  assert.equal(body.data.recurrence.mode, "once");
  assert.equal(
    body.data.recurrence.mode === "once" ? body.data.recurrence.startsAt : undefined,
    "2026-06-15T14:00:00.000Z",
  );
  assert.equal(
    body.data.recurrence.mode === "once" ? body.data.recurrence.durationSeconds : undefined,
    3_600,
  );
  // Assignees carry to the moved one-off so the assignee keeps access.
  assert.deepEqual(body.data.assignedUserIds, ["user-vip"]);
  // The original series now skips the moved date.
  assert.deepEqual(body.source.recurrence.exceptions, [{ action: "skip", date: "2026-06-15" }]);
});

test("schedule update rejects unknown assignees and accepts known ones", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:manage"]);
  const target = schedule({ id: "sched_assign" });
  const store = scheduleStore([target]);

  registerScheduleRoutes({
    app,
    assignmentIdReferences: async ({ groupIds, userIds }) => ({
      unknownGroupIds: groupIds.filter((groupId) => groupId !== "grp-known"),
      unknownUserIds: userIds.filter((userId) => userId !== "user-known"),
    }),
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const rejected = await requestJson(app, "/api/v1/schedules/sched_assign", "PATCH", {
    assignedUserIds: ["user-ghost"],
  });
  const rejectedBody = (await rejected.json()) as { reason: string; unknownUserIds: string[] };

  assert.equal(rejected.status, 400);
  assert.equal(rejectedBody.reason, "unknown_assignee");
  assert.deepEqual(rejectedBody.unknownUserIds, ["user-ghost"]);

  const accepted = await requestJson(app, "/api/v1/schedules/sched_assign", "PATCH", {
    assignedGroupIds: ["grp-known"],
    assignedUserIds: ["user-known"],
  });
  const acceptedBody = (await accepted.json()) as { data: ScheduleSummary };

  assert.equal(accepted.status, 200);
  assert.deepEqual(acceptedBody.data.assignedUserIds, ["user-known"]);
  assert.deepEqual(acceptedBody.data.assignedGroupIds, ["grp-known"]);
});

function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const actor = input.actor ?? {
      id: input.auth?.user?.id ?? "anonymous",
      name: input.auth?.user?.name ?? "Anonymous",
      roles: input.auth?.user?.roles ?? [],
      type: "user" as const,
    };
    const event: AuditEvent = {
      action: input.action,
      actor,
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function scheduleStore(schedules: ScheduleSummary[]): ScheduleStore {
  return {
    async create(schedule) {
      schedules.unshift(schedule);

      return schedule;
    },
    async delete(scheduleId) {
      const index = schedules.findIndex((candidate) => candidate.id === scheduleId);
      const [deleted] = index >= 0 ? schedules.splice(index, 1) : [];

      return deleted;
    },
    async find(scheduleId) {
      return schedules.find((candidate) => candidate.id === scheduleId);
    },
    async list() {
      return schedules;
    },
    async update(scheduleId, update) {
      const index = schedules.findIndex((candidate) => candidate.id === scheduleId);

      if (index < 0) {
        return undefined;
      }

      schedules[index] = { ...schedules[index], ...update };

      return schedules[index];
    },
  };
}

function recordingStore() {
  const recordings: RecordingSummary[] = [];

  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
    async delete(recordingId: string) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);
      const [deleted] = index >= 0 ? recordings.splice(index, 1) : [];

      return deleted;
    },
    async find(recordingId: string) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
  };
}

function user(permissions: Permission[] = ["schedule:read"]): CurrentUser {
  return {
    email: "schedule-occurrence@example.com",
    groups: [],
    id: "user_schedule_occurrence_test",
    name: "Schedule Occurrence Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Schedule Node",
    hostname: "schedule-node",
    id: "node_schedule_test",
    interfaces: [],
    ipAddresses: ["10.0.0.60"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Council Room",
      site: "Main Site",
    },
    status: "online",
    tags: ["voice"],
    ...input,
  };
}

function schedule(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id: "sched_route_test",
    name: "Council Meeting",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: node().id,
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    room: "Council Room",
    tags: ["council"],
    timezone: "UTC",
    titleTemplate: "{{date}} Council Meeting",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...input,
  };
}
