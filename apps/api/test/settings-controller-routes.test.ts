import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const controllerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-controller-settings-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CONTROLLER_SETTINGS_STORE_PATH = path.join(controllerRoot, "controller.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createControllerSettingsStore } = await import("../src/controller-settings-store.js");
const { registerSettingsControllerRoutes } = await import("../src/settings-controller-routes.js");

test.after(async () => {
  await rm(controllerRoot, { force: true, recursive: true });
});

test("controller settings read and update persist and audit", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const controllerSettingsStore = createControllerSettingsStore();

  registerSettingsControllerRoutes({
    app,
    controllerSettingsStore,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
  });

  const initial = await jsonData(app, "/api/v1/settings/controller");
  const updateResponse = await requestJson(app, "/api/v1/settings/controller", "PATCH", {
    controllerName: "Majlis Controller",
  });
  const afterUpdate = await jsonData(app, "/api/v1/settings/controller");
  const invalidEmpty = await requestJson(app, "/api/v1/settings/controller", "PATCH", {});
  const invalidBlank = await requestJson(app, "/api/v1/settings/controller", "PATCH", {
    controllerName: "   ",
  });
  const audits = await auditStore.list({ outcome: "succeeded", permission: "settings:manage" });
  const failures = await auditStore.list({ outcome: "failed", permission: "settings:manage" });
  const updateAudit = audits.find(
    (event) => event.action === "settings.controller.update.succeeded",
  );

  assert.equal(initial.controllerName, "Rakkr Controller");
  assert.equal(updateResponse.status, 200);
  assert.equal(afterUpdate.controllerName, "Majlis Controller");
  assert.equal(invalidEmpty.status, 400);
  assert.equal(invalidBlank.status, 400);
  assert.equal(updateAudit?.before?.controllerName, "Rakkr Controller");
  assert.equal(updateAudit?.after?.controllerName, "Majlis Controller");
  assert.equal(updateAudit?.target.type, "controller_settings");
  assert.ok(failures.some((event) => event.action === "settings.controller.update.failed"));
});

test("controller settings merge keeps unrelated defaults and clears one only on explicit null", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const controllerSettingsStore = createControllerSettingsStore();

  registerSettingsControllerRoutes({
    app,
    controllerSettingsStore,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
  });

  // Two defaults set in separate single-field PATCHes (the shape the console's
  // per-policy "set default" toggle actually sends): each must persist and not
  // clobber the other.
  await requestJson(app, "/api/v1/settings/controller", "PATCH", {
    defaultRecordingProfileId: "profile_hifi",
  });
  await requestJson(app, "/api/v1/settings/controller", "PATCH", {
    defaultWatchdogPolicyId: "wd_strict",
  });
  const afterSet = await readControllerSettings(app);

  // A PATCH of an unrelated field must leave both defaults untouched (keep,
  // not reset to the schema default).
  await requestJson(app, "/api/v1/settings/controller", "PATCH", { controllerName: "Keep Test" });
  const afterName = await readControllerSettings(app);

  // Explicit null clears exactly that default; an omitted field is preserved.
  // A `?? current` merge would treat the clearing null as "keep" and this would
  // regress silently — this is the case the `keep` helper exists for.
  await requestJson(app, "/api/v1/settings/controller", "PATCH", {
    defaultRecordingProfileId: null,
  });
  const afterClear = await readControllerSettings(app);

  assert.equal(afterSet.defaultRecordingProfileId, "profile_hifi");
  assert.equal(afterSet.defaultWatchdogPolicyId, "wd_strict");
  assert.equal(afterName.controllerName, "Keep Test");
  assert.equal(afterName.defaultRecordingProfileId, "profile_hifi");
  assert.equal(afterName.defaultWatchdogPolicyId, "wd_strict");
  assert.equal(afterClear.defaultRecordingProfileId, null);
  assert.equal(afterClear.defaultWatchdogPolicyId, "wd_strict");
});

test("controller settings deny without settings read and manage", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer([]);

  registerSettingsControllerRoutes({
    app,
    controllerSettingsStore: createControllerSettingsStore(),
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, currentUser),
  });

  const readResponse = await app.request("/api/v1/settings/controller");
  const updateResponse = await requestJson(app, "/api/v1/settings/controller", "PATCH", {
    controllerName: "Blocked Controller",
  });
  const readDenied = await auditStore.list({ outcome: "denied", permission: "settings:read" });
  const manageDenied = await auditStore.list({ outcome: "denied", permission: "settings:manage" });

  assert.equal(readResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(readDenied[0]?.action, "settings.controller.read");
  assert.equal(manageDenied[0]?.action, "settings.controller.update");
  assert.ok(
    [...readDenied, ...manageDenied].every((event) => event.target.type === "controller_settings"),
  );
});

function requestJson(
  app: Hono<AppBindings>,
  routePath: string,
  method: "PATCH" | "POST" | "PUT",
  body: Record<string, unknown>,
) {
  return app.request(routePath, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

async function jsonData(app: Hono<AppBindings>, routePath: string) {
  const response = await app.request(routePath);
  const body = (await response.json()) as { data: { controllerName: string } };

  assert.equal(response.status, 200);

  return body.data;
}

async function readControllerSettings(app: Hono<AppBindings>) {
  const response = await app.request("/api/v1/settings/controller");
  const body = (await response.json()) as {
    data: {
      controllerName: string;
      defaultRecordingProfileId: string | null;
      defaultWatchdogPolicyId: string | null;
    };
  };

  assert.equal(response.status, 200);

  return body.data;
}

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
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
      details: { requiredPermission: permission },
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

function viewer(permissions = ["settings:read"]): CurrentUser {
  return {
    email: "controller-settings-viewer@example.com",
    groups: [],
    id: "user_controller_settings_viewer_test",
    name: "Controller Settings Viewer Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
