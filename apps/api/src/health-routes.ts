import type { Context, Hono } from "hono";
import { z } from "zod";
import { healthEventStatusSchema, healthSeveritySchema, type HealthEvent } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type {
  HealthEventCreateInput,
  HealthEventFilters,
  HealthEventLifecycleUpdate,
  HealthEventStore,
} from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { RecordingStore } from "./recording-store.js";

interface HealthRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  healthEventStore: HealthEventStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
}

const optionalTextFilterSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().trim().max(160).optional(),
);
const healthEventsQuerySchema = z.object({
  limit: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).max(500).optional(),
  ),
  nodeId: optionalTextFilterSchema,
  recordingId: optionalTextFilterSchema,
  scheduleId: optionalTextFilterSchema,
  severity: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    healthSeveritySchema.optional(),
  ),
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    healthEventStatusSchema.optional(),
  ),
  type: optionalTextFilterSchema,
});
const optionalIsoDateSchema = optionalTextFilterSchema.refine(
  (value) => !value || !Number.isNaN(Date.parse(value)),
  "Expected an ISO date/time value",
);
const healthEventCreateSchema = z
  .object({
    details: z.record(z.string(), z.unknown()).default({}),
    nodeId: optionalTextFilterSchema,
    openedAt: optionalIsoDateSchema,
    recordingId: optionalTextFilterSchema,
    scheduleId: optionalTextFilterSchema,
    severity: healthSeveritySchema,
    type: z.string().trim().min(1).max(160),
  })
  .strict()
  .refine(
    (value) => Boolean(value.nodeId || value.recordingId || value.scheduleId),
    "Expected at least one target",
  );
const healthLifecycleSchema = z
  .object({
    note: z.string().trim().max(1000).optional(),
    suppressedUntil: optionalIsoDateSchema,
  })
  .strict();

export function registerHealthRoutes({
  app,
  currentAuth,
  currentUser,
  hasResourceScope,
  healthEventStore,
  recordAuditEvent,
  recordingStore,
  requirePermission,
}: HealthRouteDependencies) {
  app.get(
    "/api/v1/health-events",
    requirePermission("health:read", "health.events.read", healthReadTarget),
    async (c) => {
      const query = healthEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid health event filters", issues: query.error.issues }, 400);
      }

      const user = currentUser(c);
      const events = await healthEventStore.list(healthFilters(query.data));
      const visibleEvents: HealthEvent[] = [];

      for (const event of events) {
        if (await visibleHealthEvent(user, event, hasResourceScope)) {
          visibleEvents.push(event);
        }
      }

      return c.json({ data: visibleEvents });
    },
  );

  app.post(
    "/api/v1/health-events",
    requirePermission("health:acknowledge", "health.events.create", () => ({ type: "health" })),
    async (c) => {
      const body = healthEventCreateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordHealthFailure(c, "health.events.create.failed", "invalid_request");
        return c.json({ error: "Invalid health event", issues: body.error.issues }, 400);
      }

      const input = healthCreateInput(body.data);

      if (!(await canManageHealthTargets(currentUser(c), healthEventTargets(input)))) {
        await recordHealthFailure(c, "health.events.create.failed", "missing_resource_scope");
        return c.json({ error: "Forbidden" }, 403);
      }

      const event = await healthEventStore.create(input);
      await syncRecordingHealth(healthEventStore, recordingStore, event.recordingId);
      await recordAuditEvent(c, {
        action: "health.events.create.succeeded",
        after: healthEventSnapshot(event),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "health:acknowledge",
        target: healthAuditTarget(event),
      });

      return c.json({ data: event }, 201);
    },
  );

  app.post(
    "/api/v1/health-events/:eventId/acknowledge",
    requirePermission("health:acknowledge", "health.events.acknowledge", () => ({
      type: "health",
    })),
    async (c) => updateHealthLifecycle(c, "acknowledge"),
  );

  app.post(
    "/api/v1/health-events/:eventId/suppress",
    requirePermission("health:acknowledge", "health.events.suppress", () => ({
      type: "health",
    })),
    async (c) => updateHealthLifecycle(c, "suppress"),
  );

  app.post(
    "/api/v1/health-events/:eventId/resolve",
    requirePermission("health:acknowledge", "health.events.resolve", () => ({
      type: "health",
    })),
    async (c) => updateHealthLifecycle(c, "resolve"),
  );

  app.post(
    "/api/v1/health-events/:eventId/reopen",
    requirePermission("health:acknowledge", "health.events.reopen", () => ({ type: "health" })),
    async (c) => updateHealthLifecycle(c, "reopen"),
  );

  async function updateHealthLifecycle(
    c: Context<AppBindings>,
    action: "acknowledge" | "reopen" | "resolve" | "suppress",
  ) {
    const eventId = c.req.param("eventId");

    if (!eventId) {
      await recordHealthFailure(c, `health.events.${action}.failed`, "missing_health_event_id");
      return c.json({ error: "Health event id is required" }, 400);
    }

    const event = await healthEventStore.find(eventId);

    if (!event) {
      await recordHealthFailure(c, `health.events.${action}.failed`, "health_event_not_found", {
        id: eventId,
        type: "health_event",
      });
      return c.json({ error: "Health event not found" }, 404);
    }

    if (!(await visibleHealthEvent(currentUser(c), event, hasResourceScope))) {
      await recordHealthFailure(c, `health.events.${action}.failed`, "missing_resource_scope", {
        id: event.id,
        type: "health_event",
      });
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = healthLifecycleSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!body.success) {
      await recordHealthFailure(c, `health.events.${action}.failed`, "invalid_request", {
        id: event.id,
        type: "health_event",
      });
      return c.json({ error: "Invalid health lifecycle update", issues: body.error.issues }, 400);
    }

    if (event.status === "resolved" && action !== "reopen") {
      await recordHealthFailure(c, `health.events.${action}.failed`, "health_event_resolved", {
        id: event.id,
        type: "health_event",
      });
      return c.json({ error: "Health event is already resolved" }, 409);
    }

    const update = healthLifecycleUpdate(event, action, currentUser(c).id, body.data);
    const updated = await healthEventStore.updateLifecycle(event.id, update);

    if (!updated) {
      await recordHealthFailure(c, `health.events.${action}.failed`, "health_event_not_found", {
        id: event.id,
        type: "health_event",
      });
      return c.json({ error: "Health event not found" }, 404);
    }

    await syncRecordingHealth(healthEventStore, recordingStore, updated.recordingId);
    await recordAuditEvent(c, {
      action: `health.events.${action}.succeeded`,
      after: healthEventSnapshot(updated),
      auth: currentAuth(c),
      before: healthEventSnapshot(event),
      outcome: "succeeded",
      permission: "health:acknowledge",
      target: healthAuditTarget(updated),
    });

    return c.json({ data: updated });
  }

  async function canManageHealthTargets(
    user: NonNullable<AuthResult["user"]>,
    targets: AuditTarget[],
  ) {
    for (const target of targets) {
      if (!(await hasResourceScope(user, target))) {
        return false;
      }
    }

    return true;
  }

  async function recordHealthFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    target: AuditTarget = { type: "health" },
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission: "health:acknowledge",
      reason,
      target,
    });
  }
}

function healthReadTarget(c: Context<AppBindings>): AuditTarget {
  const query = c.req.query();

  if (query.recordingId) {
    return { id: query.recordingId, type: "recording" };
  }

  if (query.scheduleId) {
    return { id: query.scheduleId, type: "schedule" };
  }

  if (query.nodeId) {
    return { id: query.nodeId, type: "node" };
  }

  return { type: "health" };
}

function healthFilters(input: z.infer<typeof healthEventsQuerySchema>): HealthEventFilters {
  return {
    limit: input.limit,
    nodeId: input.nodeId,
    recordingId: input.recordingId,
    scheduleId: input.scheduleId,
    severity: input.severity,
    status: input.status,
    type: input.type,
  };
}

async function visibleHealthEvent(
  user: NonNullable<AuthResult["user"]>,
  event: HealthEvent,
  hasResourceScope: HealthRouteDependencies["hasResourceScope"],
) {
  const targets = healthEventTargets(event);

  if (targets.length === 0) {
    return true;
  }

  for (const target of targets) {
    if (await hasResourceScope(user, target)) {
      return true;
    }
  }

  return false;
}

function healthEventTargets(event: HealthEvent | HealthEventCreateInput): AuditTarget[] {
  const targets: AuditTarget[] = [];

  if (event.recordingId) {
    targets.push({ id: event.recordingId, type: "recording" });
  }

  if (event.scheduleId) {
    targets.push({ id: event.scheduleId, type: "schedule" });
  }

  if (event.nodeId) {
    targets.push({ id: event.nodeId, type: "node" });
  }

  return targets;
}

function healthCreateInput(input: z.infer<typeof healthEventCreateSchema>): HealthEventCreateInput {
  return {
    details: input.details,
    nodeId: input.nodeId,
    openedAt: input.openedAt ? new Date(input.openedAt) : undefined,
    recordingId: input.recordingId,
    scheduleId: input.scheduleId,
    severity: input.severity,
    type: input.type,
  };
}

function healthLifecycleUpdate(
  event: HealthEvent,
  action: "acknowledge" | "reopen" | "resolve" | "suppress",
  actorId: string,
  input: z.infer<typeof healthLifecycleSchema>,
): HealthEventLifecycleUpdate {
  const now = new Date();
  const note = input.note ? { [`${action}Note`]: input.note } : {};
  const details = {
    ...event.details,
    ...note,
  };

  if (action === "acknowledge") {
    return {
      acknowledgedAt: event.acknowledgedAt ? new Date(event.acknowledgedAt) : now,
      acknowledgedBy: event.acknowledgedBy ?? actorId,
      details,
      status: event.status === "suppressed" ? "suppressed" : "acknowledged",
    };
  }

  if (action === "suppress") {
    return {
      acknowledgedAt: event.acknowledgedAt ? new Date(event.acknowledgedAt) : now,
      acknowledgedBy: event.acknowledgedBy ?? actorId,
      details,
      status: "suppressed",
      suppressedAt: now,
      suppressedBy: actorId,
      suppressedUntil: input.suppressedUntil ? new Date(input.suppressedUntil) : null,
    };
  }

  if (action === "resolve") {
    return {
      details,
      resolvedAt: now,
      resolvedBy: actorId,
      status: "resolved",
    };
  }

  return {
    details,
    resolvedAt: null,
    resolvedBy: null,
    status: "open",
    suppressedAt: null,
    suppressedBy: null,
    suppressedUntil: null,
  };
}

function healthEventSnapshot(event: HealthEvent) {
  return {
    acknowledgedAt: event.acknowledgedAt,
    acknowledgedBy: event.acknowledgedBy,
    nodeId: event.nodeId,
    recordingId: event.recordingId,
    resolvedAt: event.resolvedAt,
    resolvedBy: event.resolvedBy,
    scheduleId: event.scheduleId,
    severity: event.severity,
    status: event.status,
    suppressedAt: event.suppressedAt,
    suppressedBy: event.suppressedBy,
    suppressedUntil: event.suppressedUntil,
    type: event.type,
  };
}

function healthAuditTarget(event: HealthEvent): AuditTarget {
  return {
    id: event.id,
    name: event.type,
    type: "health_event",
  };
}
