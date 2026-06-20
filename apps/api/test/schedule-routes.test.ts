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

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-schedule-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "recording-jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { registerScheduleRoutes } = await import("../src/schedule-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("schedule routes deny users without required permissions", async () => {
  const auditStore = createAuditStore("");
  const deniedUser = user([]);
  const app = new Hono<AppBindings>();

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: deniedUser }),
    currentUser: () => deniedUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: denyMissingPermission(auditStore, deniedUser),
    scheduleStore: scheduleStore([schedule()]),
    scopedSchedules: async () => [],
    settingsStore: createSettingsStore(),
  });

  const responses = await Promise.all([
    app.request("/api/v1/schedules"),
    app.request(`/api/v1/schedules/${schedule().id}/occurrences`),
    requestJson(app, "/api/v1/schedules", "POST", {
      enabled: true,
      name: "Blocked Schedule",
      nodeId: node().id,
      room: "Council Room",
      timezone: "UTC",
    }),
    requestJson(app, `/api/v1/schedules/${schedule().id}`, "PATCH", {
      name: "Blocked Rename",
    }),
    app.request(`/api/v1/schedules/${schedule().id}/run-now`, { method: "POST" }),
    app.request(`/api/v1/schedules/${schedule().id}/skip-next`, { method: "POST" }),
    app.request(`/api/v1/schedules/${schedule().id}`, { method: "DELETE" }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => `${event.permission}:${event.action}`).sort(), [
    "schedule:manage:schedules.create",
    "schedule:manage:schedules.delete",
    "schedule:manage:schedules.run_now",
    "schedule:manage:schedules.skip_next",
    "schedule:manage:schedules.update",
    "schedule:read:schedules.occurrences.read",
    "schedule:read:schedules.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === deniedUser.id));
});

test("schedule routes create update run-now and skip-next with audit events", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["recording:read", "schedule:read", "schedule:manage"]);
  const routeNode = node({ id: `node_schedule_ops_${randomUUID()}` });
  const schedules: ScheduleSummary[] = [];
  const store = scheduleStore(schedules);
  const recordings = recordingStore();
  const scheduleId = `sched_route_ops_${randomUUID()}`;

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([routeNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordings,
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const created = await requestJson(app, "/api/v1/schedules", "POST", {
    enabled: true,
    folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
    id: scheduleId,
    name: "Council Route Test",
    nodeId: routeNode.id,
    recurrence: {
      endTime: "10:00",
      interval: 1,
      mode: "daily",
      startEarlySeconds: 300,
      startTime: "09:00",
      stopLateSeconds: 120,
    },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    room: "Council Room",
    tags: ["voice", "route", "voice"],
    timezone: "UTC",
    titleTemplate: "{{date}}_{{time}}_{{schedule.name}}",
    uploadPolicyId: "upload-policy-stub",
    watchdogPolicyId: "scheduled-voice-watchdog",
  });
  const createdBody = (await created.json()) as { data: ScheduleSummary };
  const updated = await requestJson(app, `/api/v1/schedules/${scheduleId}`, "PATCH", {
    name: "Council Route Test Updated",
    tags: ["updated", "voice", "updated"],
  });
  const updatedBody = (await updated.json()) as { data: ScheduleSummary };
  const occurrences = await app.request(`/api/v1/schedules/${scheduleId}/occurrences?limit=2`);
  const runNow = await app.request(`/api/v1/schedules/${scheduleId}/run-now`, { method: "POST" });
  const runNowBody = (await runNow.json()) as {
    data: RecordingSummary;
    job: { recordingId: string };
    segments: Array<{ recordingId: string }>;
  };
  const beforeSkip = await store.find(scheduleId);
  const skipped = await app.request(`/api/v1/schedules/${scheduleId}/skip-next`, {
    method: "POST",
  });
  const skippedBody = (await skipped.json()) as { data: ScheduleSummary };
  const succeededAudits = await auditStore.list({
    outcome: "succeeded",
    permission: "schedule:manage",
  });
  const runNowAudit = succeededAudits.find(
    (event) => event.action === "schedules.run_now.succeeded",
  );

  assert.equal(created.status, 201);
  assert.equal(updated.status, 200);
  assert.equal(occurrences.status, 200);
  assert.equal(runNow.status, 202);
  assert.equal(skipped.status, 200);
  assert.equal(createdBody.data.id, scheduleId);
  assert.deepEqual(createdBody.data.tags, ["voice", "route"]);
  assert.equal(updatedBody.data.name, "Council Route Test Updated");
  assert.deepEqual(updatedBody.data.tags, ["updated", "voice"]);
  assert.equal(runNowBody.data.scheduleId, scheduleId);
  assert.equal(runNowBody.data.retentionPolicyId, "retention-keep-controller-cache");
  assert.equal(runNowBody.job.recordingId, runNowBody.data.id);
  assert.deepEqual(
    runNowBody.segments.map((segment) => segment.recordingId),
    [runNowBody.data.id],
  );
  assert.equal((await recordings.list())[0]?.source, "schedule");
  assert.notEqual(skippedBody.data.nextRunAt, beforeSkip?.nextRunAt);
  assert.ok(
    skippedBody.data.recurrence.exceptions?.some((exception) => exception.action === "skip"),
  );
  assert.deepEqual(succeededAudits.map((event) => event.action).sort(), [
    "schedules.create.succeeded",
    "schedules.run_now.succeeded",
    "schedules.skip_next.succeeded",
    "schedules.update.succeeded",
  ]);
  assert.equal(runNowAudit?.correlationIds?.scheduleId, scheduleId);
  assert.equal(runNowAudit?.after?.recordingId, runNowBody.data.id);
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

function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
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
    email: "schedule-viewer@example.com",
    groups: [],
    id: "user_schedule_viewer_test",
    name: "Schedule Viewer Test",
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
    uploadPolicyId: "upload-policy-stub",
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...input,
  };
}
