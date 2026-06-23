import type { Context, Hono } from "hono";
import type { HealthEvent, Permission } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import { healthEventTargets, visibleHealthEvent } from "./health-visibility.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";

interface HealthActionRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  healthEventStore: HealthEventStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

interface HealthActionState {
  enabled: boolean;
  href?: string;
  method: "GET" | "POST";
  permission: Permission;
  reason?: string;
}

type HealthLifecycleAction = "acknowledge" | "reopen" | "resolve" | "suppress";

export function registerHealthActionRoutes({
  app,
  currentUser,
  hasResourceScope,
  healthEventStore,
  recordAuditEvent,
  requirePermission,
}: HealthActionRouteDependencies) {
  app.get(
    "/api/v1/health-events/:eventId/actions",
    requirePermission("health:read", "health.events.actions.read", (c) => ({
      id: c.req.param("eventId"),
      type: "health_event",
    })),
    async (c) => {
      const eventId = c.req.param("eventId");
      const user = currentUser(c);
      const event = await healthEventStore.find(eventId);

      if (!event || !(await visibleHealthEvent(user, event, hasResourceScope))) {
        await recordAuditEvent(c, {
          action: "health.events.actions.read.failed",
          auth: { user },
          outcome: "failed",
          permission: "health:read",
          reason: "health_event_not_found",
          target: { id: eventId, type: "health_event" },
        });

        return c.json({ error: "Health event not found" }, 404);
      }

      const actions = healthActions(event, user.permissions);
      const targets = healthEventTargets(event);

      await recordAuditEvent(c, {
        action: "health.events.actions.read.succeeded",
        auth: { user },
        details: {
          eventStatus: event.status,
          eventType: event.type,
          severity: event.severity,
          targetCount: targets.length,
          visibleActionCount: Object.keys(actions).length,
        },
        outcome: "succeeded",
        permission: "health:read",
        target: { id: event.id, type: "health_event" },
      });

      return c.json({
        data: {
          actions,
          event,
          links: healthActionLinks(event.id),
          targets,
        },
      });
    },
  );
}

function healthActions(event: HealthEvent, permissions: readonly Permission[]) {
  return {
    acknowledge: lifecycleActionState(event, permissions, "acknowledge"),
    detail: actionState({
      href: `/api/v1/health-events/${event.id}`,
      method: "GET",
      permission: "health:read",
      permissions,
      ready: true,
    }),
    reopen: lifecycleActionState(event, permissions, "reopen"),
    resolve: lifecycleActionState(event, permissions, "resolve"),
    suppress: lifecycleActionState(event, permissions, "suppress"),
  };
}

function lifecycleActionState(
  event: HealthEvent,
  permissions: readonly Permission[],
  action: HealthLifecycleAction,
) {
  return actionState({
    href: `/api/v1/health-events/${event.id}/${action}`,
    method: "POST",
    permission: "health:acknowledge",
    permissions,
    ready: lifecycleReady(event, action),
    reason: lifecycleBlockedReason(event, action),
  });
}

function lifecycleReady(event: HealthEvent, action: HealthLifecycleAction) {
  if (event.status === "resolved") {
    return action === "reopen";
  }

  if (action === "reopen") {
    return false;
  }

  if (event.status === "open") {
    return true;
  }

  if (event.status === "acknowledged") {
    return action === "suppress" || action === "resolve";
  }

  return action === "resolve";
}

function lifecycleBlockedReason(event: HealthEvent, action: HealthLifecycleAction) {
  if (event.status === "resolved" && action !== "reopen") {
    return "health_event_resolved";
  }

  if (action === "reopen") {
    return "health_event_not_resolved";
  }

  if (action === "acknowledge" && event.status !== "open") {
    return "health_event_not_open";
  }

  if (action === "suppress" && event.status === "suppressed") {
    return "health_event_already_suppressed";
  }

  return "health_lifecycle_not_allowed";
}

function actionState({
  href,
  method,
  permission,
  permissions,
  ready,
  reason,
}: {
  href?: string;
  method: HealthActionState["method"];
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): HealthActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason };
}

function healthActionLinks(eventId: string) {
  const basePath = `/api/v1/health-events/${eventId}`;

  return {
    acknowledge: `${basePath}/acknowledge`,
    bulkLifecycle: "/api/v1/health-events/bulk-lifecycle",
    detail: basePath,
    reopen: `${basePath}/reopen`,
    resolve: `${basePath}/resolve`,
    suppress: `${basePath}/suppress`,
  };
}
