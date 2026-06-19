import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { registerScheduleRoutes } from "../src/schedule-routes.js";
import type { ScheduleStore } from "../src/schedule-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { createSettingsStore } = await import("../src/settings-store.js");

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

function node(): RecorderNode {
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
    room: "Council Room",
    tags: ["council"],
    timezone: "UTC",
    titleTemplate: "{{date}} Council Meeting",
    uploadPolicyId: "upload-policy-stub",
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...input,
  };
}
