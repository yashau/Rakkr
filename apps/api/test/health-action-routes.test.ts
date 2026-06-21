import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  HealthEvent,
  Permission,
  RecordingSummary,
} from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { registerHealthRoutes } = await import("../src/health-routes.js");

test("health event action summary returns lifecycle readiness and links", async () => {
  const healthEvent = event({
    id: "health_action_open",
    nodeId: "node_health_action",
    status: "open",
  });
  const permissionCalls: PermissionCall[] = [];
  const app = healthActionsApp({
    events: [healthEvent],
    permissionCalls,
    user: user(["health:acknowledge", "health:read"]),
  });

  const response = await app.request(`/api/v1/health-events/${healthEvent.id}/actions`);
  const body = (await response.json()) as HealthActionsResponse;

  assert.equal(response.status, 200);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "health.events.actions.read",
    permission: "health:read",
    target: { id: healthEvent.id, type: "health_event" },
  });
  assert.equal(body.data.event.id, healthEvent.id);
  assert.deepEqual(body.data.targets, [{ id: "node_health_action", type: "node" }]);
  assert.equal(body.data.actions.detail.enabled, true);
  assert.equal(body.data.actions.acknowledge.enabled, true);
  assert.equal(body.data.actions.suppress.enabled, true);
  assert.equal(body.data.actions.resolve.enabled, true);
  assert.equal(body.data.actions.reopen.enabled, false);
  assert.equal(body.data.actions.reopen.reason, "health_event_not_resolved");
  assert.equal(body.data.links.acknowledge, `/api/v1/health-events/${healthEvent.id}/acknowledge`);
});

test("health event action summary reports permission blockers", async () => {
  const healthEvent = event({
    id: "health_action_permission",
    status: "resolved",
  });
  const app = healthActionsApp({
    events: [healthEvent],
    permissionCalls: [],
    user: user(["health:read"]),
  });

  const response = await app.request(`/api/v1/health-events/${healthEvent.id}/actions`);
  const body = (await response.json()) as HealthActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.actions.detail.enabled, true);
  assert.equal(body.data.actions.acknowledge.enabled, false);
  assert.equal(body.data.actions.acknowledge.reason, "missing_permission");
  assert.equal(body.data.actions.resolve.reason, "missing_permission");
  assert.equal(body.data.actions.reopen.reason, "missing_permission");
});

test("health event action summary exposes lifecycle blockers after permission passes", async () => {
  const resolved = event({
    id: "health_action_resolved",
    resolvedAt: "2026-06-20T14:00:00.000Z",
    status: "resolved",
  });
  const suppressed = event({
    id: "health_action_suppressed",
    status: "suppressed",
    suppressedAt: "2026-06-20T13:00:00.000Z",
  });
  const app = healthActionsApp({
    events: [resolved, suppressed],
    permissionCalls: [],
    user: user(["health:acknowledge", "health:read"]),
  });

  const resolvedResponse = await app.request(`/api/v1/health-events/${resolved.id}/actions`);
  const suppressedResponse = await app.request(`/api/v1/health-events/${suppressed.id}/actions`);
  const resolvedBody = (await resolvedResponse.json()) as HealthActionsResponse;
  const suppressedBody = (await suppressedResponse.json()) as HealthActionsResponse;

  assert.equal(resolvedResponse.status, 200);
  assert.equal(resolvedBody.data.actions.reopen.enabled, true);
  assert.equal(resolvedBody.data.actions.acknowledge.reason, "health_event_resolved");
  assert.equal(resolvedBody.data.actions.suppress.reason, "health_event_resolved");
  assert.equal(resolvedBody.data.actions.resolve.reason, "health_event_resolved");
  assert.equal(suppressedResponse.status, 200);
  assert.equal(suppressedBody.data.actions.resolve.enabled, true);
  assert.equal(suppressedBody.data.actions.acknowledge.reason, "health_event_not_open");
  assert.equal(suppressedBody.data.actions.suppress.reason, "health_event_already_suppressed");
});

test("health event action summary hides events outside scoped visibility", async () => {
  const healthEvent = event({ id: "health_action_hidden", nodeId: "node_hidden" });
  const permissionCalls: PermissionCall[] = [];
  const app = healthActionsApp({
    events: [healthEvent],
    hasResourceScope: async (_user, target) => target.id !== "node_hidden",
    permissionCalls,
    user: user(["health:read"]),
  });

  const response = await app.request(`/api/v1/health-events/${healthEvent.id}/actions`);

  assert.equal(response.status, 404);
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: healthEvent.id,
    type: "health_event",
  });
});

interface HealthActionsResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; reason?: string }>;
    event: HealthEvent;
    links: Record<string, string>;
    targets: AuditTarget[];
  };
}

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function healthActionsApp({
  events,
  hasResourceScope = async () => true,
  permissionCalls,
  user: currentUser,
}: {
  events: HealthEvent[];
  hasResourceScope?: (user: CurrentUser, target: AuditTarget) => Promise<boolean>;
  permissionCalls: PermissionCall[];
  user: CurrentUser;
}) {
  const app = new Hono<AppBindings>();

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope,
    healthEventStore: createHealthEventStore("", events),
    recordAuditEvent: recordAuditEvent(),
    recordingStore: memoryRecordingStore(),
    requirePermission: requirePermission(permissionCalls),
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    calls.push({
      action,
      permission,
      target: target ? await target(c) : undefined,
    });
    await next();
  };
}

function recordAuditEvent(): RecordAuditEvent {
  const auditStore = createAuditStore("");

  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: input.auth?.user?.id ?? "user_health_action",
        name: input.auth?.user?.name ?? "Health Action User",
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

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);
      const [deleted] = index >= 0 ? recordings.splice(index, 1) : [];

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      recordings.unshift(recording);
    },
  };
}

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "health-action@example.com",
    groups: [],
    id: "user_health_action",
    name: "Health Action User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function event(input: Partial<HealthEvent> = {}): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_action",
    openedAt: "2026-06-20T12:00:00.000Z",
    resolvedAt: null,
    severity: "warning",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.node_offline",
    ...input,
  };
}
