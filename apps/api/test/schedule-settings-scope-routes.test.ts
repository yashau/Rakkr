import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import {
  defaultKeepControllerCacheRetentionPolicy,
  defaultScheduledVoiceWatchdogPolicy,
  defaultStubUploadPolicy,
  defaultVoiceRecordingProfile,
} from "@rakkr/shared";
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

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-schedule-settings-scope-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "recording-jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { registerScheduleRoutes } = await import("../src/schedule-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("schedule create rejects hidden settings resources before persisting", async () => {
  const hiddenCases = [
    { id: defaultVoiceRecordingProfile.id, type: "recording_profile" },
    { id: defaultScheduledVoiceWatchdogPolicy.id, type: "watchdog_policy" },
    { id: defaultKeepControllerCacheRetentionPolicy.id, type: "retention_policy" },
    { id: defaultStubUploadPolicy.id, type: "upload_policy" },
  ];

  for (const hiddenTarget of hiddenCases) {
    const app = new Hono<AppBindings>();
    const auditStore = createAuditStore("");
    const store = scheduleStore([]);
    const currentUser = user(["schedule:manage", "schedule:read"]);

    registerScheduleRoutes({
      app,
      currentAuth: () => ({ user: currentUser }),
      currentUser: () => currentUser,
      hasResourceScope: async (_user, target) =>
        target.type !== hiddenTarget.type || target.id !== hiddenTarget.id,
      nodeStore: createNodeStore([node()]),
      recordAuditEvent: recordAuditEvent(auditStore),
      recordingStore: recordingStore(),
      requirePermission: allowPermission(),
      scheduleStore: store,
      scopedNodes: async () => [node()],
      scopedSchedules: () => store.list(),
      settingsStore: createSettingsStore(),
    });

    const response = await requestJson(app, "/api/v1/schedules", "POST", {
      enabled: true,
      folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
      id: `sched_hidden_settings_${hiddenTarget.type}`,
      name: "Hidden Settings Schedule",
      nodeId: node().id,
      recordingProfileId: defaultVoiceRecordingProfile.id,
      retentionPolicyId: defaultKeepControllerCacheRetentionPolicy.id,
      room: "Council Room",
      timezone: "UTC",
      titleTemplate: "{{date}}_{{time}}_{{schedule.name}}",
      uploadPolicyIds: [defaultStubUploadPolicy.id],
      watchdogPolicyId: defaultScheduledVoiceWatchdogPolicy.id,
    });
    const [event] = await auditStore.list({ action: "schedules.create.failed" });

    assert.equal(response.status, 403);
    assert.equal(event?.outcome, "denied");
    assert.equal(event?.reason, "missing_resource_scope");
    assert.equal(event?.target.id, hiddenTarget.id);
    assert.equal(event?.target.type, hiddenTarget.type);
    assert.equal((await store.list()).length, 0);
  }
});

test("schedule update rejects hidden settings resources before mutating", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:manage", "schedule:read"]);
  const visible = schedule({ id: "sched_hidden_update_settings", name: "Original Schedule" });
  const store = scheduleStore([visible]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async (_user, target) =>
      target.id !== defaultKeepControllerCacheRetentionPolicy.id,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const response = await requestJson(app, `/api/v1/schedules/${visible.id}`, "PATCH", {
    name: "Should Not Persist",
    retentionPolicyId: defaultKeepControllerCacheRetentionPolicy.id,
  });
  const [event] = await auditStore.list({ action: "schedules.update.failed" });
  const stored = await store.find(visible.id);

  assert.equal(response.status, 403);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "missing_resource_scope");
  assert.equal(event?.target.id, defaultKeepControllerCacheRetentionPolicy.id);
  assert.equal(event?.target.type, "retention_policy");
  assert.equal(stored?.name, "Original Schedule");
});

function requestJson(
  app: Hono<AppBindings>,
  route: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
) {
  return app.request(route, {
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
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: input.auth?.user?.id ?? "anonymous",
        name: input.auth?.user?.name ?? "Anonymous",
        roles: input.auth?.user?.roles ?? [],
        type: "user",
      },
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
    async delete() {
      return undefined;
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
    async delete() {
      return undefined;
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

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "schedule-settings-scope@example.com",
    groups: [],
    id: "user_schedule_settings_scope",
    name: "Schedule Settings Scope",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
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
    recordingProfileId: defaultVoiceRecordingProfile.id,
    retentionPolicyId: defaultKeepControllerCacheRetentionPolicy.id,
    room: "Council Room",
    tags: ["council"],
    timezone: "UTC",
    titleTemplate: "{{date}} Council Meeting",
    uploadPolicyIds: [defaultStubUploadPolicy.id],
    watchdogPolicyId: defaultScheduledVoiceWatchdogPolicy.id,
    ...input,
  };
}
