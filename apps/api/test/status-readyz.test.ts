import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  RecordingProfile,
  WatchdogPolicy,
} from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { SettingsStore } from "../src/settings-store.js";

// /readyz is the readiness probe target: it must return 503 while the backing
// database is unreachable (so Kubernetes keeps the pod out of the Service) and
// 200 once the controller can serve traffic. It is unauthenticated — probes
// carry no session. Liveness stays on /healthz (covered by status-routes.test).

const { createHealthEventStore } = await import("../src/health-store.js");
const { registerStatusRoutes } = await import("../src/status-routes.js");

function buildApp(checkDatabaseReady: () => Promise<boolean>): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  registerStatusRoutes({
    app,
    checkDatabaseReady,
    currentUser: () => {
      throw new Error("readiness probe must not resolve a user");
    },
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
    recordAuditEvent: noopAudit,
    requirePermission: allowPermission,
    scopedNodes: async () => [],
    scopedRecordings: async () => [],
    settingsStore: emptySettingsStore,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  return app;
}

test("readyz returns 503 when the database is unreachable", async () => {
  const app = buildApp(async () => false);

  const response = await app.request("/readyz");
  const body = (await response.json()) as { ok: boolean; database: string };

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.database, "unreachable");
});

test("readyz returns 200 when the database is reachable", async () => {
  const app = buildApp(async () => true);

  const response = await app.request("/readyz");
  const body = (await response.json()) as { ok: boolean; database: string };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.database, "ready");
});

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

const noopAudit: RecordAuditEvent = async () => undefined as never;

const emptySettingsStore: SettingsStore = {
  async assignChannelMapTemplate() {
    throw new Error("not implemented");
  },
  async createChannelMapTemplate() {
    throw new Error("not implemented");
  },
  async findChannelMapTemplate() {
    return undefined;
  },
  async findRecordingProfile() {
    return undefined;
  },
  async findWatchdogPolicy() {
    return undefined;
  },
  async listChannelMapAssignments(): Promise<ChannelMapTemplateAssignment[]> {
    return [];
  },
  async listChannelMapTemplates(): Promise<ChannelMapTemplate[]> {
    return [];
  },
  async listRecordingProfiles(): Promise<RecordingProfile[]> {
    return [];
  },
  async listWatchdogPolicies(): Promise<WatchdogPolicy[]> {
    return [];
  },
  async rollbackChannelMapAssignment() {
    return undefined;
  },
  async updateChannelMapTemplate() {
    return undefined;
  },
  async updateRecordingProfile() {
    return undefined;
  },
  async updateWatchdogPolicy() {
    return undefined;
  },
};
