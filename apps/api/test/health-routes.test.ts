import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { registerHealthRoutes } = await import("../src/health-routes.js");

test("health routes deny users without required permissions", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user([]);

  registerHealthRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    requirePermission: denyMissingPermission(auditStore, currentUser),
  });

  const responses = await Promise.all([
    app.request("/api/v1/health-events"),
    requestJson(app, "/api/v1/health-events", "POST", {
      nodeId: "node_health_denied",
      severity: "warning",
      type: "test.low_signal",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/acknowledge", "POST", {
      note: "blocked",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/suppress", "POST", {
      note: "blocked",
      suppressedUntil: "2026-06-19T13:00:00.000Z",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/resolve", "POST", {
      note: "blocked",
    }),
    requestJson(app, "/api/v1/health-events/health_denied/reopen", "POST", {
      note: "blocked",
    }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => `${event.permission}:${event.action}`).sort(), [
    "health:acknowledge:health.events.acknowledge",
    "health:acknowledge:health.events.create",
    "health:acknowledge:health.events.reopen",
    "health:acknowledge:health.events.resolve",
    "health:acknowledge:health.events.suppress",
    "health:read:health.events.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === currentUser.id));
});

function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "POST",
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
    email: "health-denied@example.com",
    groups: [],
    id: "user_health_denied",
    name: "Health Denied",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
