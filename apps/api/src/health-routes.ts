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
import { registerHealthActionRoutes } from "./health-action-routes.js";
import { healthEventTargets, visibleHealthEvent } from "./health-visibility.js";
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
  openedFrom: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().datetime().optional(),
  ),
  openedTo: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().datetime().optional(),
  ),
  recordingId: optionalTextFilterSchema,
  resolvedFrom: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().datetime().optional(),
  ),
  resolvedTo: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().datetime().optional(),
  ),
  scheduleId: optionalTextFilterSchema,
  search: optionalTextFilterSchema,
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
const healthLifecycleActionSchema = z.enum(["acknowledge", "reopen", "resolve", "suppress"]);
type HealthLifecycleAction = z.infer<typeof healthLifecycleActionSchema>;
const healthBulkLifecycleSchema = healthLifecycleSchema.extend({
  action: healthLifecycleActionSchema,
  eventIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
});
const healthEventSelectedExportSchema = z
  .object({
    eventIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
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
  registerHealthActionRoutes({
    app,
    currentUser,
    hasResourceScope,
    healthEventStore,
    requirePermission,
  });

  app.get(
    "/api/v1/health-events/export",
    requirePermission("health:read", "health.events.export", healthReadTarget),
    async (c) => {
      const query = healthEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid health event filters", issues: query.error.issues }, 400);
      }

      const filters = healthFilters(query.data);
      const events = await visibleHealthEvents(currentUser(c), filters, {
        hasResourceScope,
        healthEventStore,
      });

      await recordAuditEvent(c, {
        action: "health.events.export.succeeded",
        auth: currentAuth(c),
        details: {
          exportedCount: events.length,
          filters,
        },
        outcome: "succeeded",
        permission: "health:read",
        target: healthReadTarget(c),
      });

      return c.text(healthEventsCsv(events), 200, {
        "Content-Disposition": `attachment; filename="${healthExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.post(
    "/api/v1/health-events/export",
    requirePermission("health:read", "health.events.export_selected", () => ({
      type: "health",
    })),
    async (c) => {
      const body = healthEventSelectedExportSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSelectedHealthExportFailure(c, "invalid_request");
        return c.json(
          { error: "Invalid health event export request", issues: body.error.issues },
          400,
        );
      }

      const eventIds = uniqueHealthEventIds(body.data.eventIds);
      const events: HealthEvent[] = [];

      for (const eventId of eventIds) {
        const event = await healthEventStore.find(eventId);

        if (!event) {
          await recordSelectedHealthExportFailure(c, "health_event_not_found", {
            eventIds,
            missingId: eventId,
          });
          return c.json({ error: "Health event not found", eventId }, 404);
        }

        if (!(await visibleHealthEvent(currentUser(c), event, hasResourceScope))) {
          await recordSelectedHealthExportFailure(c, "health_event_not_visible", {
            eventIds,
            hiddenId: event.id,
          });
          return c.json({ error: "One or more health events are not visible" }, 404);
        }

        events.push(event);
      }

      await recordAuditEvent(c, {
        action: "health.events.export_selected.succeeded",
        auth: currentAuth(c),
        correlationIds: Object.fromEntries(
          eventIds.map((eventId, index) => [`healthEventId${index + 1}`, eventId]),
        ),
        details: {
          exportedCount: events.length,
          requestedCount: body.data.eventIds.length,
        },
        outcome: "succeeded",
        permission: "health:read",
        target: {
          type: "health",
        },
      });

      return c.text(healthEventsCsv(events), 200, {
        "Content-Disposition": `attachment; filename="${healthExportFileName()}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    },
  );

  app.get(
    "/api/v1/health-events",
    requirePermission("health:read", "health.events.read", healthReadTarget),
    async (c) => {
      const query = healthEventsQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid health event filters", issues: query.error.issues }, 400);
      }

      const user = currentUser(c);
      const visibleEvents = await visibleHealthEvents(user, healthFilters(query.data), {
        hasResourceScope,
        healthEventStore,
      });

      return c.json({ data: visibleEvents });
    },
  );

  app.get(
    "/api/v1/health-events/:eventId",
    requirePermission("health:read", "health.events.detail.read", (c) => ({
      id: c.req.param("eventId"),
      type: "health_event",
    })),
    async (c) => {
      const eventId = c.req.param("eventId");
      const event = await healthEventStore.find(eventId);

      if (!event || !(await visibleHealthEvent(currentUser(c), event, hasResourceScope))) {
        return c.json({ error: "Health event not found" }, 404);
      }

      return c.json({ data: event });
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
    "/api/v1/health-events/bulk-lifecycle",
    requirePermission("health:acknowledge", "health.events.bulk_lifecycle", () => ({
      type: "health",
    })),
    async (c) => {
      const body = healthBulkLifecycleSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordHealthFailure(c, "health.events.bulk_lifecycle.failed", "invalid_request");
        return c.json(
          { error: "Invalid health bulk lifecycle update", issues: body.error.issues },
          400,
        );
      }

      const eventIds = Array.from(new Set(body.data.eventIds));
      const events: HealthEvent[] = [];

      for (const eventId of eventIds) {
        const event = await healthEventStore.find(eventId);

        if (!event) {
          await recordHealthFailure(
            c,
            "health.events.bulk_lifecycle.failed",
            "health_event_not_found",
            {
              id: eventId,
              type: "health_event",
            },
          );
          return c.json({ error: "Health event not found", eventId }, 404);
        }

        if (!(await visibleHealthEvent(currentUser(c), event, hasResourceScope))) {
          await recordHealthFailure(
            c,
            "health.events.bulk_lifecycle.failed",
            "missing_resource_scope",
            {
              id: event.id,
              type: "health_event",
            },
          );
          return c.json({ error: "Forbidden", eventId: event.id }, 403);
        }

        if (event.status === "resolved" && body.data.action !== "reopen") {
          await recordHealthFailure(
            c,
            "health.events.bulk_lifecycle.failed",
            "health_event_resolved",
            {
              id: event.id,
              type: "health_event",
            },
          );
          return c.json({ error: "Health event is already resolved", eventId: event.id }, 409);
        }

        events.push(event);
      }

      const updatedEvents: HealthEvent[] = [];

      for (const event of events) {
        const updated = await applyHealthLifecycleUpdate(c, event, body.data.action, body.data);

        if (!updated) {
          return c.json({ error: "Health event not found", eventId: event.id }, 404);
        }

        updatedEvents.push(updated);
      }

      return c.json({
        data: updatedEvents,
        meta: { updatedCount: updatedEvents.length },
      });
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

  async function updateHealthLifecycle(c: Context<AppBindings>, action: HealthLifecycleAction) {
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

    const updated = await applyHealthLifecycleUpdate(c, event, action, body.data);

    if (!updated) {
      await recordHealthFailure(c, `health.events.${action}.failed`, "health_event_not_found", {
        id: event.id,
        type: "health_event",
      });
      return c.json({ error: "Health event not found" }, 404);
    }

    return c.json({ data: updated });
  }

  async function applyHealthLifecycleUpdate(
    c: Context<AppBindings>,
    event: HealthEvent,
    action: HealthLifecycleAction,
    input: z.infer<typeof healthLifecycleSchema>,
  ) {
    const update = healthLifecycleUpdate(event, action, currentUser(c).id, input);
    const updated = await healthEventStore.updateLifecycle(event.id, update);

    if (!updated) {
      await recordHealthFailure(c, `health.events.${action}.failed`, "health_event_not_found", {
        id: event.id,
        type: "health_event",
      });
      return undefined;
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

    return updated;
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

  async function recordSelectedHealthExportFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "health.events.export_selected.failed",
      auth: currentAuth(c),
      details,
      outcome: reason === "health_event_not_visible" ? "denied" : "failed",
      permission: "health:read",
      reason,
      target: {
        type: "health",
      },
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
    openedFrom: input.openedFrom ? new Date(input.openedFrom) : undefined,
    openedTo: input.openedTo ? new Date(input.openedTo) : undefined,
    recordingId: input.recordingId,
    resolvedFrom: input.resolvedFrom ? new Date(input.resolvedFrom) : undefined,
    resolvedTo: input.resolvedTo ? new Date(input.resolvedTo) : undefined,
    scheduleId: input.scheduleId,
    search: input.search,
    severity: input.severity,
    status: input.status,
    type: input.type,
  };
}

async function visibleHealthEvents(
  user: NonNullable<AuthResult["user"]>,
  filters: HealthEventFilters,
  dependencies: Pick<HealthRouteDependencies, "hasResourceScope" | "healthEventStore">,
) {
  const events = await dependencies.healthEventStore.list(filters);
  const visibleEvents: HealthEvent[] = [];

  for (const event of events) {
    if (await visibleHealthEvent(user, event, dependencies.hasResourceScope)) {
      visibleEvents.push(event);
    }
  }

  return visibleEvents;
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
  action: HealthLifecycleAction,
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

function healthEventsCsv(events: HealthEvent[]) {
  return [
    csvRow([
      "id",
      "type",
      "severity",
      "status",
      "nodeId",
      "scheduleId",
      "recordingId",
      "openedAt",
      "acknowledgedAt",
      "suppressedUntil",
      "resolvedAt",
      "details",
    ]),
    ...events.map((event) =>
      csvRow([
        event.id,
        event.type,
        event.severity,
        event.status,
        event.nodeId ?? "",
        event.scheduleId ?? "",
        event.recordingId ?? "",
        event.openedAt,
        event.acknowledgedAt ?? "",
        event.suppressedUntil ?? "",
        event.resolvedAt ?? "",
        jsonCell(event.details),
      ]),
    ),
  ].join("\n");
}

function csvRow(values: string[]) {
  return values.map(csvCell).join(",");
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function jsonCell(value: unknown) {
  return value ? JSON.stringify(value) : "";
}

function healthExportFileName() {
  return `rakkr-health-events-${new Date().toISOString().replaceAll(":", "-")}.csv`;
}

function uniqueHealthEventIds(eventIds: string[]) {
  return Array.from(new Set(eventIds));
}
