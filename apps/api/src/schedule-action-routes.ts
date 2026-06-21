import type { Context, Hono } from "hono";
import type { Permission, ScheduleSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RequirePermission } from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import { skipNextScheduleOccurrence } from "./schedule-engine.js";
import type { ScheduleStore } from "./schedule-store.js";

interface ScheduleActionRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  nodeStore: NodeStore;
  requirePermission: RequirePermission;
  scheduleStore: ScheduleStore;
  scopedSchedules: (user: NonNullable<AuthResult["user"]>) => Promise<ScheduleSummary[]>;
}

interface ScheduleActionState {
  enabled: boolean;
  href?: string;
  method: "DELETE" | "GET" | "PATCH" | "POST";
  permission: Permission;
  reason?: string;
}

export function registerScheduleActionRoutes({
  app,
  currentUser,
  nodeStore,
  requirePermission,
  scheduleStore,
  scopedSchedules,
}: ScheduleActionRouteDependencies) {
  app.get(
    "/api/v1/schedules/:scheduleId/actions",
    requirePermission("schedule:read", "schedules.actions.read", (c) => ({
      id: c.req.param("scheduleId"),
      type: "schedule",
    })),
    async (c) => {
      const scheduleId = c.req.param("scheduleId");
      const user = currentUser(c);
      const visible = (await scopedSchedules(user)).find((schedule) => schedule.id === scheduleId);

      if (!visible) {
        return c.json({ error: "Schedule not found" }, 404);
      }

      const [schedule, node] = await Promise.all([
        scheduleStore.find(scheduleId),
        nodeStore.find(visible.nodeId),
      ]);

      if (!schedule) {
        return c.json({ error: "Schedule not found" }, 404);
      }

      return c.json({
        data: {
          actions: scheduleActions(schedule, user.permissions, Boolean(node)),
          links: scheduleActionLinks(schedule.id),
          node,
          schedule,
        },
      });
    },
  );
}

function scheduleActions(
  schedule: ScheduleSummary,
  permissions: readonly Permission[],
  nodeAvailable: boolean,
) {
  const basePath = `/api/v1/schedules/${schedule.id}`;
  const hasNextOccurrence = Boolean(skipNextScheduleOccurrence(schedule));

  return {
    delete: actionState({
      href: basePath,
      method: "DELETE",
      permission: "schedule:manage",
      permissions,
      ready: true,
    }),
    edit: actionState({
      href: basePath,
      method: "PATCH",
      permission: "schedule:manage",
      permissions,
      ready: true,
    }),
    occurrences: actionState({
      href: `${basePath}/occurrences`,
      method: "GET",
      permission: "schedule:read",
      permissions,
      ready: true,
    }),
    runNow: actionState({
      href: `${basePath}/run-now`,
      method: "POST",
      permission: "schedule:manage",
      permissions,
      ready: schedule.enabled && nodeAvailable,
      reason: schedule.enabled ? "schedule_node_not_found" : "schedule_disabled",
    }),
    skipNext: actionState({
      href: `${basePath}/skip-next`,
      method: "POST",
      permission: "schedule:manage",
      permissions,
      ready: schedule.enabled && hasNextOccurrence,
      reason: schedule.enabled ? "no_next_occurrence" : "schedule_disabled",
    }),
  };
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
  method: ScheduleActionState["method"];
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): ScheduleActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason };
}

function scheduleActionLinks(scheduleId: string) {
  const basePath = `/api/v1/schedules/${scheduleId}`;

  return {
    delete: basePath,
    detail: basePath,
    occurrences: `${basePath}/occurrences`,
    runNow: `${basePath}/run-now`,
    skipNext: `${basePath}/skip-next`,
    update: basePath,
  };
}
