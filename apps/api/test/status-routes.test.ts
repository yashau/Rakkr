import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
  ChannelMapTemplate,
  ChannelMapTemplateAssignment,
  CurrentUser,
  HealthEvent,
  Permission,
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
  WatchdogPolicy,
} from "@rakkr/shared";
import type { AppBindings, RequirePermission } from "../src/http-types.js";
import type { SettingsStore } from "../src/settings-store.js";

const { createHealthEventStore } = await import("../src/health-store.js");
const { registerStatusRoutes } = await import("../src/status-routes.js");

test("status health counts honor aggregate health event denies", async () => {
  const healthEventStore = createHealthEventStore("", [
    healthEvent({
      id: "health_status_hidden",
      nodeId: "node_status_health",
      recordingId: "rec_status_health",
      severity: "critical",
      status: "open",
      type: "watchdog.recording_quality",
    }),
  ]);
  const app = new Hono<AppBindings>();

  registerStatusRoutes({
    app,
    currentUser: () => user(["node:read"]),
    hasResourceScope: async (_user, target) =>
      target.id === "node_status_health" || target.id === "rec_status_health",
    healthEventStore,
    requirePermission: allowPermission,
    scopedNodes: async () => [node("node_status_health")],
    scopedRecordings: async () => [recording("rec_status_health", "node_status_health")],
    settingsStore: emptySettingsStore,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/api/v1/status");
  const body = (await response.json()) as {
    criticalAlerts: number;
    nodeCount: number;
    openAlerts: number;
    totalRecordings: number;
    unresolvedAlerts: number;
  };

  assert.equal(response.status, 200);
  assert.equal(body.nodeCount, 1);
  assert.equal(body.totalRecordings, 1);
  assert.equal(body.criticalAlerts, 0);
  assert.equal(body.openAlerts, 0);
  assert.equal(body.unresolvedAlerts, 0);
});

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

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

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "status-route@example.com",
    groups: [],
    id: "user_status_route",
    name: "Status Route User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function node(id: string): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: id,
    hostname: id,
    id,
    interfaces: [],
    ipAddresses: [],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {},
    status: "online",
    tags: [],
  };
}

function recording(id: string, nodeId: string): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "status",
    healthStatus: "unknown",
    id,
    name: id,
    nodeId,
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: [],
  };
}

function healthEvent(input: Partial<HealthEvent> = {}): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_status_test",
    openedAt: "2026-06-18T12:00:00.000Z",
    resolvedAt: null,
    severity: "warning",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.node_offline",
    ...input,
  };
}
