import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
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
import { defaultScheduledVoiceWatchdogPolicy, defaultVoiceRecordingProfile } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { SettingsStore } from "../src/settings-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { registerStatusRoutes } = await import("../src/status-routes.js");

test("status health counts honor aggregate health event denies", async () => {
  const auditStore = createAuditStore("");
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
    recordAuditEvent: recordAuditEvent(auditStore),
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
  const [event] = await auditStore.list({ action: "status.read.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.nodeCount, 1);
  assert.equal(body.totalRecordings, 1);
  assert.equal(body.criticalAlerts, 0);
  assert.equal(body.openAlerts, 0);
  assert.equal(body.unresolvedAlerts, 0);
  assert.equal(event?.permission, "node:read");
  assert.equal(event?.target.type, "controller");
  assert.equal(event?.details.nodeCount, 1);
  assert.equal(event?.details.totalRecordings, 1);
  assert.equal(event?.details.criticalAlerts, 0);
  assert.equal(event?.details.openAlerts, 0);
  assert.equal(event?.details.unresolvedAlerts, 0);
  assert.equal(event?.details.canReadSettings, false);
});

test("status embedded settings summaries honor resource-scope denies", async () => {
  const auditStore = createAuditStore("");
  const visibleProfile: RecordingProfile = {
    ...defaultVoiceRecordingProfile,
    id: "profile_status_visible",
    name: "Visible Status Profile",
  };
  const visibleWatchdog: WatchdogPolicy = {
    ...defaultScheduledVoiceWatchdogPolicy,
    id: "watchdog_status_visible",
    name: "Visible Status Watchdog",
  };
  const app = new Hono<AppBindings>();

  registerStatusRoutes({
    app,
    currentUser: () => user(["node:read", "settings:read"]),
    hasResourceScope: async (_user, target) =>
      target.id !== defaultVoiceRecordingProfile.id &&
      target.id !== defaultScheduledVoiceWatchdogPolicy.id,
    healthEventStore: createHealthEventStore("", []),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission,
    scopedNodes: async () => [],
    scopedRecordings: async () => [],
    settingsStore: settingsStore(
      [defaultVoiceRecordingProfile, visibleProfile],
      [defaultScheduledVoiceWatchdogPolicy, visibleWatchdog],
    ),
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/api/v1/status");
  const body = (await response.json()) as {
    recordingProfile?: RecordingProfile;
    watchdogPolicy?: WatchdogPolicy;
  };
  const [event] = await auditStore.list({ action: "status.read.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.recordingProfile?.id, visibleProfile.id);
  assert.equal(body.watchdogPolicy?.id, visibleWatchdog.id);
  assert.equal(event?.details.canReadSettings, true);
  assert.equal(event?.details.recordingProfileAvailable, true);
  assert.equal(event?.details.watchdogPolicyAvailable, true);
});

test("healthz reports service identity and version", async () => {
  const app = new Hono<AppBindings>();

  registerStatusRoutes({
    app,
    currentUser: () => user(["node:read"]),
    hasResourceScope: async () => true,
    healthEventStore: createHealthEventStore("", []),
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    requirePermission: allowPermission,
    scopedNodes: async () => [],
    scopedRecordings: async () => [],
    settingsStore: emptySettingsStore,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/healthz");
  const body = (await response.json()) as {
    ok: boolean;
    service: string;
    startedAt: string;
    version: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "rakkr-api");
  assert.equal(body.startedAt, "2026-06-18T12:00:00.000Z");
  assert.equal(body.version, "0.0.0-dev");
});

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: input.auth?.user?.id ?? "user_status_route",
        name: input.auth?.user?.name ?? "Status Route User",
        roles: input.auth?.user?.roles ?? [],
        type: "user",
      },
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

function settingsStore(
  profiles: RecordingProfile[],
  watchdogPolicies: WatchdogPolicy[],
): SettingsStore {
  return {
    ...emptySettingsStore,
    async findRecordingProfile(profileId) {
      return profiles.find((profile) => profile.id === profileId);
    },
    async findWatchdogPolicy(policyId) {
      return watchdogPolicies.find((policy) => policy.id === policyId);
    },
    async listRecordingProfiles() {
      return profiles;
    },
    async listWatchdogPolicies() {
      return watchdogPolicies;
    },
  };
}

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
