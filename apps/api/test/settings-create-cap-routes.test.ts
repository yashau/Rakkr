import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const settingsRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-create-cap-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(settingsRoot, "profiles.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(settingsRoot, "watchdog-policies.json");

const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");

test.after(async () => {
  await rm(settingsRoot, { force: true, recursive: true });
});

// Create bodies derive from the same bounded writable schema the PATCH routes
// use, so create must reject anything update would reject. A name past the
// varchar(160) column budget would otherwise 500/latch on insert, and over-cap
// numerics would diverge from what the update path accepts.
test("settings create routes enforce the same input ceilings as update", async () => {
  const app = new Hono<AppBindings>();

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: manager() }),
    recordAuditEvent: noopAudit,
    requirePermission: allowPermission(),
    settingsStore: createSettingsStore(),
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const longName = "x".repeat(200);
  const rejected = await Promise.all([
    requestJson(app, "/api/v1/settings/recording-profiles", { name: longName }),
    requestJson(app, "/api/v1/settings/recording-profiles", { bitrateKbps: 4096, name: "Over" }),
    requestJson(app, "/api/v1/settings/watchdog-policies", { name: longName }),
    requestJson(app, "/api/v1/settings/watchdog-policies", { graceSeconds: 999_999, name: "Over" }),
  ]);
  const accepted = await Promise.all([
    requestJson(app, "/api/v1/settings/recording-profiles", { name: "Within Caps" }),
    requestJson(app, "/api/v1/settings/watchdog-policies", { name: "Within Caps" }),
  ]);

  assert.deepEqual(
    rejected.map((response) => response.status),
    [400, 400, 400, 400],
  );
  assert.deepEqual(
    accepted.map((response) => response.status),
    [201, 201],
  );
});

function requestJson(app: Hono<AppBindings>, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

const noopAudit: RecordAuditEvent = async (_c, input) => ({
  action: input.action,
  actor: { id: "test", name: "Test", roles: [], type: "user" as const },
  actorContext: {},
  after: input.after,
  before: input.before,
  correlationIds: input.correlationIds,
  createdAt: new Date().toISOString(),
  details: input.details ?? {},
  id: "audit_test",
  outcome: input.outcome,
  permission: input.permission,
  reason: input.reason,
  target: input.target,
});

function manager(): CurrentUser {
  return {
    email: "settings-manager@example.com",
    groups: [],
    id: "user_settings_manager_test",
    name: "Settings Manager Test",
    permissions: ["settings:read", "settings:manage"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
