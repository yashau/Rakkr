import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, ScheduleSummary } from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { ScheduleStore } from "../src/schedule-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerScheduleRoutes } = await import("../src/schedule-routes.js");

test("schedule routes deny users without required permissions", async () => {
  const auditStore = createAuditStore("");
  const deniedUser = user([]);
  const app = scheduleApp(auditStore, deniedUser);

  const responses = await Promise.all([
    app.request("/api/v1/schedules"),
    app.request("/api/v1/schedules/sched_blocked/occurrences"),
    app.request("/api/v1/schedules", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    app.request("/api/v1/schedules/sched_blocked", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }),
    app.request("/api/v1/schedules/sched_blocked/run-now", { method: "POST" }),
    app.request("/api/v1/schedules/sched_blocked/skip-next", { method: "POST" }),
    app.request("/api/v1/schedules/sched_blocked", { method: "DELETE" }),
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

function scheduleApp(auditStore: ReturnType<typeof createAuditStore>, currentUser: CurrentUser) {
  const app = new Hono<AppBindings>();

  registerScheduleRoutes({
    app,
    currentAuth: () => auth(currentUser),
    currentUser: () => currentUser,
    nodeStore: emptyNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: emptyRecordingStore(),
    requirePermission: denyMissingPermission(auditStore, currentUser),
    scheduleStore: emptyScheduleStore(),
    scopedSchedules: async () => [],
    settingsStore: emptySettingsStore(),
  });

  return app;
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

function emptyNodeStore(): NodeStore {
  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find() {
      return undefined;
    },
    async heartbeat() {
      return undefined;
    },
    async list() {
      return [];
    },
    async rotateCredential() {
      return undefined;
    },
    async update() {
      return undefined;
    },
    async updateInterface() {
      return undefined;
    },
  };
}

function emptyRecordingStore(): RecordingStore {
  return {
    async create() {},
    async delete() {
      return undefined;
    },
    async find() {
      return undefined;
    },
    async list() {
      return [];
    },
    async save() {},
  };
}

function emptyScheduleStore(): ScheduleStore {
  return {
    async create(schedule: ScheduleSummary) {
      return schedule;
    },
    async delete() {
      return undefined;
    },
    async find() {
      return undefined;
    },
    async list() {
      return [];
    },
    async update() {
      return undefined;
    },
  };
}

function emptySettingsStore(): SettingsStore {
  return {
    async assignChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async createChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async findChannelMapTemplate() {
      return undefined;
    },
    async findRecordingProfile() {
      return undefined;
    },
    async findWatchdogPolicy() {
      return undefined;
    },
    async listChannelMapAssignments() {
      return [];
    },
    async listChannelMapTemplates() {
      return [];
    },
    async listRecordingProfiles() {
      return [];
    },
    async listWatchdogPolicies() {
      return [];
    },
    async rollbackChannelMapAssignment() {
      return undefined;
    },
    async updateChannelMapTemplate() {
      return undefined;
    },
    async updateRecordingProfile() {
      return undefined;
    },
    async updateWatchdogPolicy() {
      return undefined;
    },
  };
}

function auth(currentUser: CurrentUser): AuthResult {
  return { user: currentUser };
}

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "schedule-route@example.com",
    groups: [],
    id: "user_schedule_route",
    name: "Schedule Route User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
