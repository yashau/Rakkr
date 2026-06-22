import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  HealthEvent,
  Permission,
  RecorderNode,
  RecordingSummary,
} from "@rakkr/shared";
import type { AppBindings, AuditTarget, RequirePermission } from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-metrics-routes-"));
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(routeRoot, "retention-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { createMeterFrameStore } = await import("../src/meter-store.js");
const { registerMetricsRoutes } = await import("../src/metrics-routes.js");
const { createNodeStore } = await import("../src/node-store.js");
const { createRecordingJob } = await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("metrics audit totals respect resource scope", async () => {
  const auditStore = createAuditStore("");

  await auditStore.append(
    auditEvent("recordings.download.succeeded", "succeeded", "recording:download", {
      id: "rec_visible",
      type: "recording",
    }),
  );
  await auditStore.append(
    auditEvent("recordings.delete.succeeded", "succeeded", "recording:delete", {
      id: "rec_hidden",
      type: "recording",
    }),
  );
  await auditStore.append(
    auditEvent("metrics.read", "succeeded", "metrics:read", {
      type: "controller",
    }),
  );

  const app = new Hono<AppBindings>();
  registerMetricsRoutes({
    app,
    auditStore,
    currentUser: () => user(["metrics:read"]),
    hasResourceScope: async (_user, target) => target.id === "rec_visible",
    healthEventStore: createHealthEventStore("", []),
    listenMonitorStore: createListenMonitorStore(),
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([]),
    recordingStore: memoryRecordingStore([]),
    requirePermission: allowPermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/metrics");
  const output = await response.text();

  assert.equal(response.status, 200);
  assert.match(output, /rakkr_audit_events_total\{action="metrics\.read"/);
  assert.match(output, /rakkr_audit_events_total\{action="recordings\.download\.succeeded"/);
  assert.doesNotMatch(output, /recordings\.delete\.succeeded/);
});

test("metrics audit totals respect health event resource scope", async () => {
  const auditStore = createAuditStore("");

  await auditStore.append(
    auditEvent("health.events.visible.succeeded", "succeeded", "health:acknowledge", {
      id: "health_audit_visible",
      type: "health_event",
    }),
  );
  await auditStore.append(
    auditEvent("health.events.hidden.succeeded", "succeeded", "health:acknowledge", {
      id: "health_audit_hidden",
      type: "health_event",
    }),
  );

  const app = new Hono<AppBindings>();
  registerMetricsRoutes({
    app,
    auditStore,
    currentUser: () => user(["metrics:read"]),
    hasResourceScope: async (_user, target) => target.id === "health_audit_visible",
    healthEventStore: createHealthEventStore("", []),
    listenMonitorStore: createListenMonitorStore(),
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([]),
    recordingStore: memoryRecordingStore([]),
    requirePermission: allowPermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/metrics");
  const output = await response.text();

  assert.equal(response.status, 200);
  assert.match(output, /health\.events\.visible\.succeeded/);
  assert.doesNotMatch(output, /health\.events\.hidden\.succeeded/);
});

test("metrics audit totals respect settings resource scope", async () => {
  const auditStore = createAuditStore("");
  const settingsTargets: AuditTarget["type"][] = [
    "channel_map_assignment_plan",
    "channel_map_template",
    "recording_profile",
    "retention_policy",
    "upload_policy",
    "upload_provider",
    "watchdog_policy",
  ];

  for (const targetType of settingsTargets) {
    await auditStore.append(
      auditEvent(`settings.${targetType}.visible`, "succeeded", "settings:manage", {
        id: `${targetType}_visible`,
        type: targetType,
      }),
    );
    await auditStore.append(
      auditEvent(`settings.${targetType}.hidden`, "succeeded", "settings:manage", {
        id: `${targetType}_hidden`,
        type: targetType,
      }),
    );
  }

  const app = new Hono<AppBindings>();
  registerMetricsRoutes({
    app,
    auditStore,
    currentUser: () => user(["metrics:read"]),
    hasResourceScope: async (_user, target) => target.id?.endsWith("_visible") ?? false,
    healthEventStore: createHealthEventStore("", []),
    listenMonitorStore: createListenMonitorStore(),
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([]),
    recordingStore: memoryRecordingStore([]),
    requirePermission: allowPermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/metrics");
  const output = await response.text();

  assert.equal(response.status, 200);

  for (const targetType of settingsTargets) {
    assert.match(output, new RegExp(`settings\\.${targetType}\\.visible`));
    assert.doesNotMatch(output, new RegExp(`settings\\.${targetType}\\.hidden`));
  }
});

test("metrics expose listen monitor chunks only for visible nodes", async () => {
  const listenMonitorStore = createListenMonitorStore();

  await listenMonitorStore.save({
    audio: new Uint8Array([82, 73, 70, 70]),
    capturedAt: "2026-06-18T12:15:57.000Z",
    contentType: "audio/wav",
    durationMs: 1500,
    nodeId: "node_visible",
  });
  await listenMonitorStore.save({
    audio: new Uint8Array([82, 73, 70, 70]),
    capturedAt: "2026-06-18T12:15:57.000Z",
    contentType: "audio/wav",
    durationMs: 1500,
    nodeId: "node_hidden",
  });

  const app = new Hono<AppBindings>();
  registerMetricsRoutes({
    app,
    auditStore: createAuditStore(""),
    currentUser: () => user(["metrics:read"]),
    hasResourceScope: async (_user, target) => target.id === "node_visible",
    healthEventStore: createHealthEventStore("", []),
    listenMonitorStore,
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([node("node_visible"), node("node_hidden")]),
    recordingStore: memoryRecordingStore([]),
    requirePermission: allowPermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/metrics");
  const output = await response.text();

  assert.equal(response.status, 200);
  assert.match(output, /rakkr_listen_monitor_chunk_age_seconds\{node_id="node_visible"/);
  assert.doesNotMatch(output, /node_hidden/);
});

test("metrics recording job totals require visible recording context", async () => {
  const visibleRecording = recording("rec_metrics_visible", "node_metrics_jobs");
  const hiddenRecording = recording("rec_metrics_hidden", "node_metrics_jobs");

  await createRecordingJob(visibleRecording);
  await createRecordingJob(hiddenRecording);

  const app = new Hono<AppBindings>();
  registerMetricsRoutes({
    app,
    auditStore: createAuditStore(""),
    currentUser: () => user(["metrics:read"]),
    hasResourceScope: async (_user, target) =>
      target.id === "node_metrics_jobs" ||
      target.id === visibleRecording.id ||
      (target.type === "health_event" && target.id?.startsWith("health_")),
    healthEventStore: createHealthEventStore("", []),
    listenMonitorStore: createListenMonitorStore(),
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([node("node_metrics_jobs")]),
    recordingStore: memoryRecordingStore([visibleRecording]),
    requirePermission: allowPermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/metrics");
  const output = await response.text();

  assert.equal(response.status, 200);
  assert.match(output, /rakkr_recording_jobs\{node_id="node_metrics_jobs",status="queued"\} 1/);
});

test("metrics health totals honor aggregate health event denies", async () => {
  const healthEventStore = createHealthEventStore("", [
    healthEvent({
      id: "health_metrics_hidden",
      nodeId: "node_metrics_health",
      recordingId: "rec_metrics_health",
      severity: "critical",
      status: "open",
      type: "watchdog.recording_quality",
    }),
  ]);

  const app = new Hono<AppBindings>();
  registerMetricsRoutes({
    app,
    auditStore: createAuditStore(""),
    currentUser: () => user(["metrics:read"]),
    hasResourceScope: async (_user, target) =>
      target.id === "node_metrics_health" || target.id === "rec_metrics_health",
    healthEventStore,
    listenMonitorStore: createListenMonitorStore(),
    meterFrameStore: createMeterFrameStore(),
    nodeStore: createNodeStore([node("node_metrics_health")]),
    recordingStore: memoryRecordingStore([recording("rec_metrics_health", "node_metrics_health")]),
    requirePermission: allowPermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/metrics");
  const output = await response.text();

  assert.equal(response.status, 200);
  assert.match(output, /rakkr_health_events_active\{severity="critical",status="open"\} 0/);
  assert.doesNotMatch(output, /watchdog\.recording_quality/);
});

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

function auditEvent(
  action: string,
  outcome: AuditEvent["outcome"],
  permission: Permission,
  target: AuditTarget,
): AuditEvent {
  return {
    action,
    actor: {
      id: "user_metrics_route",
      name: "Metrics Route User",
      roles: ["auditor"],
      type: "user",
    },
    actorContext: {},
    createdAt: "2026-06-18T12:00:00.000Z",
    details: {},
    id: `audit_${action}`,
    outcome,
    permission,
    target,
  };
}

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "metrics-route@example.com",
    groups: [],
    id: "user_metrics_route",
    name: "Metrics Route User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["auditor"],
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

function healthEvent(input: Partial<HealthEvent> = {}): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_metrics_test",
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

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((recording) => recording.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
  };
}

function recording(id: string, nodeId: string): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "metrics",
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
