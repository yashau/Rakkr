import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const settingsRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(settingsRoot, "profiles.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(settingsRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(settingsRoot, "upload-providers.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(settingsRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { createUploadProviderStore } = await import("../src/upload-providers.js");

test.after(async () => {
  await rm(settingsRoot, { force: true, recursive: true });
});

test("settings write routes deny users without settings manage", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const settingsStore = createSettingsStore();

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: viewer() }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore),
    settingsStore,
    uploadProviderStore: createUploadProviderStore(),
  });

  const responses = await Promise.all([
    requestJson(app, "/api/v1/settings/recording-profiles/voice-mp3-vbr", "PATCH", {
      name: "Blocked Profile",
    }),
    requestJson(app, "/api/v1/settings/watchdog-policies/scheduled-voice-watchdog", "PATCH", {
      name: "Blocked Watchdog",
    }),
    requestJson(app, "/api/v1/settings/upload-providers/stub", "PATCH", {
      displayName: "Blocked Provider",
    }),
    requestJson(app, "/api/v1/settings/upload-policies", "POST", {
      enabled: true,
      maxAttempts: 1,
      name: "Blocked Upload Policy",
      provider: "stub",
      target: "stub://blocked",
      trigger: "manual",
    }),
    requestJson(app, "/api/v1/settings/channel-map-templates", "POST", {
      channelMode: "mono_to_stereo_mix",
      entries: [
        {
          included: true,
          label: "Blocked Channel",
          outputChannelIndex: 1,
          sourceChannelIndex: 1,
        },
      ],
      name: "Blocked Channel Map",
      tags: ["blocked"],
    }),
    requestJson(app, "/api/v1/settings/channel-map-assignments", "POST", {
      targetId: "node_blocked",
      targetType: "node",
      templateId: "template_blocked",
    }),
    requestJson(app, "/api/v1/settings/channel-map-assignments/rollback", "POST", {
      targetId: "node_blocked",
      targetType: "node",
    }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:manage" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(
    deniedEvents.map((event) => event.action).sort(),
    [
      "settings.channel_map_assignments.rollback",
      "settings.channel_map_assignments.update",
      "settings.channel_map_templates.create",
      "settings.recording_profiles.update",
      "settings.upload_policies.create",
      "settings.upload_providers.update",
      "settings.watchdog_policies.update",
    ],
  );
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.target.type === "settings"));
});

function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function denyMissingPermission(auditStore: ReturnType<typeof createAuditStore>): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: viewer() },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: ["viewer"],
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

function viewer(): CurrentUser {
  return {
    email: "settings-viewer@example.com",
    groups: [],
    id: "user_settings_viewer_test",
    name: "Settings Viewer Test",
    permissions: ["settings:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
