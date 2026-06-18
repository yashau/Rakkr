import type { Context, Hono } from "hono";
import { z } from "zod";
import { healthSeveritySchema, type HealthEvent } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { HealthEventFilters, HealthEventStore } from "./health-store.js";
import type { AppBindings, AuditTarget, RequirePermission } from "./http-types.js";

interface HealthRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  healthEventStore: HealthEventStore;
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
});

export function registerHealthRoutes({
  app,
  currentUser,
  hasResourceScope,
  healthEventStore,
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

function healthEventTargets(event: HealthEvent): AuditTarget[] {
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
