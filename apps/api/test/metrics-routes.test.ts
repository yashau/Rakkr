import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecorderNode } from "@rakkr/shared";
import type { AppBindings, AuditTarget, RequirePermission } from "../src/http-types.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { createMeterFrameStore } = await import("../src/meter-store.js");
const { registerMetricsRoutes } = await import("../src/metrics-routes.js");
const { createNodeStore } = await import("../src/node-store.js");
const { createRecordingStore } = await import("../src/recording-store.js");

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
    recordingStore: createRecordingStore([]),
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
    recordingStore: createRecordingStore([]),
    requirePermission: allowPermission,
    startedAt: new Date("2026-06-18T12:00:00.000Z"),
  });

  const response = await app.request("/metrics");
  const output = await response.text();

  assert.equal(response.status, 200);
  assert.match(output, /rakkr_listen_monitor_chunk_age_seconds\{node_id="node_visible"/);
  assert.doesNotMatch(output, /node_hidden/);
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
