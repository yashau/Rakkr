import type { Context, Hono } from "hono";
import { controllerSettingsUpdateSchema, type ControllerSettings } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { ControllerSettingsStore } from "./controller-settings-store.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";

interface SettingsControllerRouteDependencies {
  app: Hono<AppBindings>;
  controllerSettingsStore: ControllerSettingsStore;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

const controllerSettingsTarget = {
  id: "controller",
  type: "controller_settings",
} as const;

export function registerSettingsControllerRoutes({
  app,
  controllerSettingsStore,
  currentAuth,
  recordAuditEvent,
  requirePermission,
}: SettingsControllerRouteDependencies) {
  app.get(
    "/api/v1/settings/controller",
    requirePermission("settings:read", "settings.controller.read", () => controllerSettingsTarget),
    async (c) => {
      const data = await controllerSettingsStore.find();

      return c.json({ data });
    },
  );

  app.patch(
    "/api/v1/settings/controller",
    requirePermission(
      "settings:manage",
      "settings.controller.update",
      () => controllerSettingsTarget,
    ),
    async (c) => {
      const before = await controllerSettingsStore.find();
      const body = controllerSettingsUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordAuditEvent(c, {
          action: "settings.controller.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "settings:manage",
          reason: "invalid_request",
          target: controllerSettingsTarget,
        });
        return c.json({ error: "Invalid controller settings", issues: body.error.issues }, 400);
      }

      const updated = await controllerSettingsStore.update(body.data);

      await recordAuditEvent(c, {
        action: "settings.controller.update.succeeded",
        after: snapshot(updated),
        auth: currentAuth(c),
        before: snapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: controllerSettingsTarget,
      });

      return c.json({ data: updated });
    },
  );
}

function snapshot(settings: ControllerSettings) {
  return { controllerName: settings.controllerName };
}
