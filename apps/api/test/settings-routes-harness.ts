import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";

// Shared harness for the settings route tests. Extracted from
// settings-routes.test.ts to keep each test file under the 1000-LOC guard.
//
// The store modules read their RAKKR_*_STORE_PATH env vars at import time, so
// the env setup below MUST run before the dynamic imports.

const settingsRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_PLAN_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-assignment-plans.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(settingsRoot, "profiles.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(settingsRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(settingsRoot, "upload-providers.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(settingsRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createChannelMapAssignmentPlanStore } =
  await import("../src/channel-map-assignment-plans.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");

export {
  createAuditStore,
  createChannelMapAssignmentPlanStore,
  createSettingsStore,
  createUploadDestinationStore,
  createUploadPolicy,
  registerSettingsRoutes,
};

test.after(async () => {
  await rm(settingsRoot, { force: true, recursive: true });
});

export function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "PATCH" | "POST" | "PUT",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

export async function jsonData(app: Hono<AppBindings>, path: string) {
  const response = await app.request(path);
  const body = (await response.json()) as { data: Record<string, unknown> };

  assert.equal(response.status, 200);

  return body.data;
}

export function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

export function denyMissingPermission(
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

export function denyResourceScope(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
  isVisibleTarget: (target: AuditTarget) => boolean,
): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };
    const hasPermission = currentUser.permissions.includes(permission);
    const allowed = hasPermission && isVisibleTarget(auditTarget);

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      outcome: allowed ? "allowed" : "denied",
      permission,
      reason: hasPermission ? "access_policy_denied" : "missing_permission",
      target: auditTarget,
    });

    if (!allowed) {
      return c.json({ error: "Forbidden", permission }, 403);
    }

    await next();
  };
}

export function recordAuditEvent(
  auditStore: ReturnType<typeof createAuditStore>,
): RecordAuditEvent {
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

export function viewer(permissions = ["settings:read"]): CurrentUser {
  return {
    email: "settings-viewer@example.com",
    groups: [],
    id: "user_settings_viewer_test",
    name: "Settings Viewer Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

export function channelMapInput(id: string, name: string) {
  return {
    channelMode: "mono_to_stereo_mix",
    entries: [
      {
        included: true,
        label: "Podium Mic",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    id,
    name,
    tags: ["voice"],
  };
}
