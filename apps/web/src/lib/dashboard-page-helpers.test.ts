import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, HealthEvent, Permission, RecordingJob } from "@rakkr/shared";

import {
  dashboardActiveRecordingJobs,
  dashboardActiveHealthEvents,
  dashboardIncidentActions,
  dashboardPagePermissions,
  dashboardReportingNodes,
  dashboardSelectedNodeId,
} from "./dashboard-page-helpers";

test("dashboard reporting nodes exclude never-contacted provisioning and offline nodes", () => {
  const nodes = [
    { id: "n_prov", status: "provisioning" as const },
    { id: "n_online", status: "online" as const },
    { id: "n_recording", status: "recording" as const },
    { id: "n_degraded", status: "degraded" as const },
    { id: "n_alerting", status: "alerting" as const },
    { id: "n_offline", status: "offline" as const },
  ];

  // A provisioning node has never reported; it (and offline) must not count as
  // "reporting". A naive `status !== "offline"` filter wrongly keeps provisioning.
  assert.deepEqual(
    dashboardReportingNodes(nodes).map((node) => node.id),
    ["n_online", "n_recording", "n_degraded", "n_alerting"],
  );
});

test("dashboard page reads and meters require node read permission", () => {
  assert.deepEqual(dashboardPagePermissions(undefined), {
    canAcknowledgeHealth: false,
    canControlRecordings: false,
    canCreateRecordings: false,
    canRead: false,
    canReadHealth: false,
    canReadMeters: false,
    canReadRecordings: false,
    canReadSettings: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["metrics:read"])), {
    canAcknowledgeHealth: false,
    canControlRecordings: false,
    canCreateRecordings: false,
    canRead: false,
    canReadHealth: false,
    canReadMeters: false,
    canReadRecordings: false,
    canReadSettings: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["node:read"])), {
    canAcknowledgeHealth: false,
    canControlRecordings: false,
    canCreateRecordings: false,
    canRead: true,
    canReadHealth: false,
    canReadMeters: true,
    canReadRecordings: false,
    canReadSettings: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["health:read"])), {
    canAcknowledgeHealth: false,
    canControlRecordings: false,
    canCreateRecordings: false,
    canRead: false,
    canReadHealth: true,
    canReadMeters: false,
    canReadRecordings: false,
    canReadSettings: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["health:acknowledge"])), {
    canAcknowledgeHealth: true,
    canControlRecordings: false,
    canCreateRecordings: false,
    canRead: false,
    canReadHealth: false,
    canReadMeters: false,
    canReadRecordings: false,
    canReadSettings: false,
  });
  assert.deepEqual(
    dashboardPagePermissions(
      user(["recording:control", "recording:create", "recording:read", "settings:read"]),
    ),
    {
      canAcknowledgeHealth: false,
      canControlRecordings: true,
      canCreateRecordings: true,
      canRead: false,
      canReadHealth: false,
      canReadMeters: false,
      canReadRecordings: true,
      canReadSettings: true,
    },
  );
});

test("dashboard active recording jobs prefer running newest work", () => {
  const jobs = [
    recordingJob({
      createdAt: "2026-06-21T10:00:00.000Z",
      id: "job_queued_new",
      status: "queued",
    }),
    recordingJob({
      createdAt: "2026-06-21T12:00:00.000Z",
      id: "job_completed",
      status: "completed",
    }),
    recordingJob({
      createdAt: "2026-06-21T09:00:00.000Z",
      id: "job_running_old",
      status: "running",
    }),
    recordingJob({
      createdAt: "2026-06-21T11:00:00.000Z",
      id: "job_running_new",
      status: "running",
    }),
    recordingJob({
      createdAt: "2026-06-21T13:00:00.000Z",
      id: "job_stop_requested",
      status: "stop_requested",
    }),
  ];

  assert.deepEqual(
    dashboardActiveRecordingJobs(jobs, 3).map((job) => job.id),
    ["job_running_new", "job_running_old", "job_queued_new"],
  );
});

test("dashboard selected node stays visible or falls back to first node", () => {
  const nodes = [{ id: "node_a" }, { id: "node_b" }, { id: "node_c" }];

  assert.equal(dashboardSelectedNodeId("node_b", nodes), "node_b");
  assert.equal(dashboardSelectedNodeId("node_missing", nodes), "node_a");
  assert.equal(dashboardSelectedNodeId("", nodes), "node_a");
  assert.equal(dashboardSelectedNodeId("node_missing", []), "");
});

test("dashboard active health events prefer unresolved critical recent incidents", () => {
  const events = [
    healthEvent({
      id: "health_warning_new",
      openedAt: "2026-06-21T10:00:00.000Z",
      severity: "warning",
    }),
    healthEvent({
      id: "health_resolved_critical",
      openedAt: "2026-06-21T12:00:00.000Z",
      resolvedAt: "2026-06-21T12:30:00.000Z",
      severity: "critical",
      status: "resolved",
    }),
    healthEvent({
      id: "health_critical_old",
      openedAt: "2026-06-21T08:00:00.000Z",
      severity: "critical",
    }),
    healthEvent({
      id: "health_critical_new",
      openedAt: "2026-06-21T11:00:00.000Z",
      severity: "critical",
    }),
  ];

  assert.deepEqual(
    dashboardActiveHealthEvents(events, 2).map((event) => event.id),
    ["health_critical_new", "health_critical_old"],
  );
});

test("dashboard incident actions stay compact for active incident states", () => {
  assert.deepEqual(dashboardIncidentActions("open"), ["acknowledge", "resolve"]);
  assert.deepEqual(dashboardIncidentActions("acknowledged"), ["resolve"]);
  assert.deepEqual(dashboardIncidentActions("suppressed"), ["resolve"]);
  assert.deepEqual(dashboardIncidentActions("resolved"), []);
});

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "operator@example.test",
    groups: [],
    id: "user_operator",
    name: "Operator",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function healthEvent(input: Partial<HealthEvent> = {}) {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_1",
    openedAt: "2026-06-21T09:00:00.000Z",
    resolvedAt: null,
    severity: "info",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.node_offline",
    ...input,
  } satisfies HealthEvent;
}

function recordingJob(input: Partial<ReturnType<typeof baseRecordingJob>> = {}) {
  return {
    ...baseRecordingJob(),
    ...input,
  };
}

function baseRecordingJob(): RecordingJob {
  return {
    claimedBy: undefined,
    command: {
      captureBackend: "alsa",
      captureChannels: 2,
      captureDevice: "hw:0,0",
      captureFormat: "S16_LE",
      captureInterfaceId: undefined,
      captureSampleRate: 48_000,
      durationSeconds: 3600,
      outputCodec: "mp3",
      outputFileName: "test.mp3",
      outputVbr: true,
      type: "alsa_capture",
    },
    completedAt: undefined,
    createdAt: "2026-06-21T09:00:00.000Z",
    failureReason: undefined,
    id: "job_1",
    lastHeartbeatAt: undefined,
    leaseExpiresAt: undefined,
    nodeId: "node_1",
    recordingId: "rec_1",
    startedAt: undefined,
    status: "queued",
    stopRequestedAt: undefined,
  };
}
