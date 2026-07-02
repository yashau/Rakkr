import type { Context, Hono } from "hono";
import { z } from "zod";

import {
  switcherCreateSchema,
  switcherUpdateSchema,
  type Permission,
  type SwitcherConnectionTest,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import { switcherSettingsTarget } from "./settings-scope.js";
import type { ResolvedSwitcherConnection, SwitcherStore } from "./switcher-store.js";
import {
  getSwitcherDriver,
  withSwitcherSession,
  type SwitcherConnection,
} from "./switchers/index.js";

interface SwitcherRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  switcherStore: SwitcherStore;
}

const restoreSchema = z.object({
  snapshot: z.string().trim().min(1).max(200_000),
});

// Network op timings: probes are read-heavy line reads; the GET CONFIG snapshot
// streams hundreds of lines so it gets a longer ceiling.
const probeSessionOptions = { commandTimeoutMs: 8_000, connectTimeoutMs: 6_000, idleMs: 300 };
const snapshotSessionOptions = { commandTimeoutMs: 12_000, connectTimeoutMs: 6_000, idleMs: 350 };

function connectionFor(config: ResolvedSwitcherConnection): SwitcherConnection {
  return {
    host: config.host,
    password: config.password,
    port: config.port,
    username: config.username,
  };
}

export function registerSwitcherRoutes({
  app,
  currentAuth,
  recordAuditEvent,
  requirePermission,
  switcherStore,
}: SwitcherRouteDependencies) {
  const recordFailure = async (
    c: Context<AppBindings>,
    action: string,
    reason: string,
    permission: Permission,
    target: AuditTarget = { type: "switcher" },
  ) => {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission,
      reason,
      target,
    });
  };

  const switcherTargetFor = async (c: Context<AppBindings>): Promise<AuditTarget> => {
    const id = c.req.param("id") ?? "";
    const switcher = await switcherStore.find(id);

    return switcher ? switcherSettingsTarget(switcher) : { id, type: "switcher" };
  };

  app.get(
    "/api/v1/settings/switchers",
    requirePermission("switcher:read", "settings.switchers.read", () => ({ type: "switcher" })),
    async (c) => {
      // Switchers are controller-wide infrastructure (not room/node-scoped), so
      // any holder of switcher:read sees the full list.
      const data = await switcherStore.list();

      await recordAuditEvent(c, {
        action: "settings.switchers.read.succeeded",
        auth: currentAuth(c),
        details: { count: data.length },
        outcome: "succeeded",
        permission: "switcher:read",
        target: { type: "switcher" },
      });

      return c.json({ data });
    },
  );

  app.get(
    "/api/v1/settings/switchers/:id",
    requirePermission("switcher:read", "settings.switchers.read", switcherTargetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const switcher = await switcherStore.find(id);

      if (!switcher) {
        await recordFailure(c, "settings.switchers.read.failed", "not_found", "switcher:read", {
          id,
          type: "switcher",
        });
        return c.json({ error: "Switcher not found" }, 404);
      }

      return c.json({ data: switcher });
    },
  );

  app.post(
    "/api/v1/settings/switchers",
    requirePermission("switcher:manage", "settings.switchers.create", () => ({ type: "switcher" })),
    async (c) => {
      const body = switcherCreateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordFailure(
          c,
          "settings.switchers.create.failed",
          "invalid_request",
          "switcher:manage",
        );
        return c.json({ error: "Invalid switcher", issues: body.error.issues }, 400);
      }

      const created = await switcherStore.create(body.data);

      await recordAuditEvent(c, {
        action: "settings.switchers.create.succeeded",
        after: switcherSnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "switcher:manage",
        target: switcherSettingsTarget(created),
      });

      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/switchers/:id",
    requirePermission("switcher:manage", "settings.switchers.update", switcherTargetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const before = await switcherStore.find(id);

      if (!before) {
        await recordFailure(c, "settings.switchers.update.failed", "not_found", "switcher:manage", {
          id,
          type: "switcher",
        });
        return c.json({ error: "Switcher not found" }, 404);
      }

      const body = switcherUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordFailure(
          c,
          "settings.switchers.update.failed",
          "invalid_request",
          "switcher:manage",
          switcherSettingsTarget(before),
        );
        return c.json({ error: "Invalid switcher", issues: body.error.issues }, 400);
      }

      const updated = await switcherStore.update(id, body.data);

      if (!updated) {
        await recordFailure(
          c,
          "settings.switchers.update.failed",
          "not_found",
          "switcher:manage",
          switcherSettingsTarget(before),
        );
        return c.json({ error: "Switcher not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.switchers.update.succeeded",
        after: switcherSnapshot(updated),
        auth: currentAuth(c),
        before: switcherSnapshot(before),
        outcome: "succeeded",
        permission: "switcher:manage",
        target: switcherSettingsTarget(updated),
      });

      return c.json({ data: updated });
    },
  );

  app.delete(
    "/api/v1/settings/switchers/:id",
    requirePermission("switcher:manage", "settings.switchers.delete", switcherTargetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const before = await switcherStore.find(id);

      if (!before) {
        await recordFailure(c, "settings.switchers.delete.failed", "not_found", "switcher:manage", {
          id,
          type: "switcher",
        });
        return c.json({ error: "Switcher not found" }, 404);
      }

      await switcherStore.delete(id);

      await recordAuditEvent(c, {
        action: "settings.switchers.delete.succeeded",
        auth: currentAuth(c),
        before: switcherSnapshot(before),
        outcome: "succeeded",
        permission: "switcher:manage",
        target: switcherSettingsTarget(before),
      });

      return c.json({ data: { id } });
    },
  );

  app.post(
    "/api/v1/settings/switchers/:id/test",
    requirePermission("switcher:manage", "settings.switchers.test", switcherTargetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const config = await switcherStore.resolveConfig(id);

      if (!config) {
        await recordFailure(c, "settings.switchers.test.failed", "not_found", "switcher:manage", {
          id,
          type: "switcher",
        });
        return c.json({ error: "Switcher not found" }, 404);
      }

      const driver = getSwitcherDriver(config.model);
      let result: SwitcherConnectionTest;

      try {
        result = await withSwitcherSession(connectionFor(config), probeSessionOptions, (session) =>
          driver.test(session),
        );
      } catch (error) {
        result = {
          message: error instanceof Error ? error.message : "connect_failed",
          model: config.model,
          ok: false,
          reachable: false,
        };
      }

      await recordAuditEvent(c, {
        action: result.ok ? "settings.switchers.test.succeeded" : "settings.switchers.test.failed",
        auth: currentAuth(c),
        details: {
          firmware: result.firmware,
          ok: result.ok,
          reachable: result.reachable,
          routeCount: result.routeCount,
        },
        outcome: result.ok ? "succeeded" : "failed",
        permission: "switcher:manage",
        reason: result.ok ? undefined : (result.message ?? "test_failed"),
        target: switcherSettingsTarget({ displayName: config.displayName, id: config.id }),
      });

      return c.json({ data: result });
    },
  );

  app.get(
    "/api/v1/settings/switchers/:id/config-snapshot",
    requirePermission("switcher:manage", "settings.switchers.snapshot", switcherTargetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const config = await switcherStore.resolveConfig(id);

      if (!config) {
        await recordFailure(
          c,
          "settings.switchers.snapshot.failed",
          "not_found",
          "switcher:manage",
          {
            id,
            type: "switcher",
          },
        );
        return c.json({ error: "Switcher not found" }, 404);
      }

      const driver = getSwitcherDriver(config.model);

      try {
        const snapshot = await withSwitcherSession(
          connectionFor(config),
          snapshotSessionOptions,
          (session) => driver.snapshot(session),
        );

        await recordAuditEvent(c, {
          action: "settings.switchers.snapshot.succeeded",
          auth: currentAuth(c),
          details: { lineCount: snapshot.split("\n").length },
          outcome: "succeeded",
          permission: "switcher:manage",
          target: switcherSettingsTarget({ displayName: config.displayName, id: config.id }),
        });

        return c.json({ data: { snapshot } });
      } catch (error) {
        await recordFailure(
          c,
          "settings.switchers.snapshot.failed",
          error instanceof Error ? error.message : "snapshot_failed",
          "switcher:manage",
          switcherSettingsTarget({ displayName: config.displayName, id: config.id }),
        );
        return c.json({ error: "Snapshot failed" }, 502);
      }
    },
  );

  app.post(
    "/api/v1/settings/switchers/:id/restore",
    requirePermission("switcher:manage", "settings.switchers.restore", switcherTargetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const config = await switcherStore.resolveConfig(id);

      if (!config) {
        await recordFailure(
          c,
          "settings.switchers.restore.failed",
          "not_found",
          "switcher:manage",
          {
            id,
            type: "switcher",
          },
        );
        return c.json({ error: "Switcher not found" }, 404);
      }

      const body = restoreSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordFailure(
          c,
          "settings.switchers.restore.failed",
          "invalid_request",
          "switcher:manage",
          switcherSettingsTarget({ displayName: config.displayName, id: config.id }),
        );
        return c.json({ error: "Invalid restore payload", issues: body.error.issues }, 400);
      }

      const driver = getSwitcherDriver(config.model);

      try {
        await withSwitcherSession(connectionFor(config), snapshotSessionOptions, (session) =>
          driver.restore(session, body.data.snapshot),
        );

        await recordAuditEvent(c, {
          action: "settings.switchers.restore.succeeded",
          auth: currentAuth(c),
          outcome: "succeeded",
          permission: "switcher:manage",
          target: switcherSettingsTarget({ displayName: config.displayName, id: config.id }),
        });

        return c.json({ data: { id, restored: true } });
      } catch (error) {
        await recordFailure(
          c,
          "settings.switchers.restore.failed",
          error instanceof Error ? error.message : "restore_failed",
          "switcher:manage",
          switcherSettingsTarget({ displayName: config.displayName, id: config.id }),
        );
        return c.json({ error: "Restore failed" }, 502);
      }
    },
  );
}

// Redacted audit snapshot: never includes secrets (only hasPassword).
function switcherSnapshot(switcher: {
  displayName: string;
  enabled: boolean;
  hasPassword: boolean;
  host: string;
  id: string;
  mode: string;
  model: string;
  port: number;
  username?: string;
}) {
  return {
    displayName: switcher.displayName,
    enabled: switcher.enabled,
    hasPassword: switcher.hasPassword,
    host: switcher.host,
    id: switcher.id,
    mode: switcher.mode,
    model: switcher.model,
    port: switcher.port,
    username: switcher.username,
  };
}
