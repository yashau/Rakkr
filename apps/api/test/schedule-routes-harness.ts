import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Hono } from "hono";
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

export { createAuditStore, createNodeStore, registerScheduleRoutes, createSettingsStore };

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

export function requestJson(
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

export async function scheduleList(app: Hono<AppBindings>, query = "") {
  const response = await app.request(`/api/v1/schedules${query}`);
  const body = (await response.json()) as { data: ScheduleSummary[] };

  assert.equal(response.status, 200);

  return body.data;
}

export interface ScheduleActionsResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; reason?: string }>;
    links: Record<string, string | undefined>;
    node?: RecorderNode;
    schedule: ScheduleSummary;
  };
}

export function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

export function denyMissingPermission(
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

export function recordAuditEvent(
  auditStore: ReturnType<typeof createAuditStore>,
): RecordAuditEvent {
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

export function scheduleStore(schedules: ScheduleSummary[]): ScheduleStore {
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

export function recordingStore() {
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

export function user(permissions: Permission[] = ["schedule:read"]): CurrentUser {
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

export function node(input: Partial<RecorderNode> = {}): RecorderNode {
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

export function schedule(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
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
