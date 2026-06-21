import assert from "node:assert/strict";
import test from "node:test";
import type {
  CurrentUser,
  HealthEvent,
  Permission,
  RecorderNode,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";

import {
  emptyHealthPageFilters,
  healthEventBulkActionTargets,
  healthEventFiltersFromDraft,
  healthEventSummary,
  healthEventTargetLabel,
  healthLifecycleActions,
  healthPagePermissions,
  readableHealthEventType,
} from "./health-page-helpers";
import { localDateBoundaryIso } from "./dates";

test("health page permissions are closed by default", () => {
  assert.deepEqual(healthPagePermissions(undefined), {
    canAcknowledgeHealth: false,
    canReadHealth: false,
    canReadNodes: false,
    canReadRecordings: false,
    canReadSchedules: false,
  });
});

test("health page permissions split lifecycle and relationship lookups", () => {
  assert.deepEqual(
    healthPagePermissions(
      user(["health:acknowledge", "health:read", "node:read", "recording:read", "schedule:read"]),
    ),
    {
      canAcknowledgeHealth: true,
      canReadHealth: true,
      canReadNodes: true,
      canReadRecordings: true,
      canReadSchedules: true,
    },
  );
  assert.deepEqual(healthPagePermissions(user(["health:read"])), {
    canAcknowledgeHealth: false,
    canReadHealth: true,
    canReadNodes: false,
    canReadRecordings: false,
    canReadSchedules: false,
  });
});

test("health event filter draft trims API filters and caps limits", () => {
  assert.deepEqual(
    healthEventFiltersFromDraft({
      ...emptyHealthPageFilters,
      limit: "900",
      nodeId: " node_1 ",
      openedFromDate: "2026-06-20",
      openedToDate: "2026-06-21",
      recordingId: " ",
      resolvedFromDate: "2026-06-22",
      resolvedToDate: "2026-06-23",
      scheduleId: "sched_1",
      severity: "critical",
      status: "open",
      type: " watchdog.node_offline ",
    }),
    {
      limit: 500,
      nodeId: "node_1",
      openedFrom: localDateBoundaryIso("2026-06-20", "start"),
      openedTo: localDateBoundaryIso("2026-06-21", "end"),
      recordingId: undefined,
      resolvedFrom: localDateBoundaryIso("2026-06-22", "start"),
      resolvedTo: localDateBoundaryIso("2026-06-23", "end"),
      scheduleId: "sched_1",
      severity: "critical",
      status: "open",
      type: "watchdog.node_offline",
    },
  );
  assert.equal(
    healthEventFiltersFromDraft({ ...emptyHealthPageFilters, limit: "nope" }).limit,
    undefined,
  );
});

test("health event summary counts active and terminal states", () => {
  assert.deepEqual(
    healthEventSummary([
      event({ severity: "critical", status: "open" }),
      event({ severity: "critical", status: "acknowledged" }),
      event({ severity: "warning", status: "suppressed" }),
      event({ severity: "critical", status: "resolved" }),
    ]),
    {
      activeCritical: 2,
      open: 1,
      resolved: 1,
      suppressed: 1,
      total: 4,
    },
  );
});

test("health lifecycle actions match event status", () => {
  assert.deepEqual(healthLifecycleActions("open"), ["acknowledge", "suppress", "resolve"]);
  assert.deepEqual(healthLifecycleActions("acknowledged"), ["suppress", "resolve"]);
  assert.deepEqual(healthLifecycleActions("suppressed"), ["resolve"]);
  assert.deepEqual(healthLifecycleActions("resolved"), ["reopen"]);
});

test("health bulk action targets include only selected eligible events", () => {
  const events = [
    event({ id: "health_open", status: "open" }),
    event({ id: "health_ack", status: "acknowledged" }),
    event({ id: "health_suppressed", status: "suppressed" }),
    event({ id: "health_resolved", status: "resolved" }),
  ];

  assert.deepEqual(
    healthEventBulkActionTargets(events, ["health_open", "health_resolved"], "resolve").map(
      (healthEvent) => healthEvent.id,
    ),
    ["health_open"],
  );
  assert.deepEqual(
    healthEventBulkActionTargets(events, ["health_ack", "health_suppressed"], "suppress").map(
      (healthEvent) => healthEvent.id,
    ),
    ["health_ack"],
  );
  assert.deepEqual(
    healthEventBulkActionTargets(events, ["health_open", "health_resolved"], "reopen").map(
      (healthEvent) => healthEvent.id,
    ),
    ["health_resolved"],
  );
});

test("health event target labels prefer visible friendly names", () => {
  assert.equal(
    healthEventTargetLabel(
      event({ nodeId: "node_1", recordingId: "rec_1", scheduleId: "sched_1" }),
      {
        nodes: [node("node_1", "Room Node")],
        recordings: [recording("rec_1", "Morning Council")],
        schedules: [schedule("sched_1", "Council Daily")],
      },
    ),
    "Node Room Node / Schedule Council Daily / Recording Morning Council",
  );
  assert.equal(
    healthEventTargetLabel(event({ nodeId: "node_1", recordingId: "rec_1" }), {}),
    "node_1 / rec_1",
  );
});

test("health event type labels collapse common technical names", () => {
  assert.equal(readableHealthEventType("watchdog.node_offline"), "node offline");
  assert.equal(
    readableHealthEventType("controller.recording.upload_queue_failed"),
    "upload queue failed",
  );
  assert.equal(
    readableHealthEventType("agent.meter.device_unavailable"),
    "meter device unavailable",
  );
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

function event(input: Partial<HealthEvent> = {}): HealthEvent {
  return {
    acknowledgedAt: null,
    details: {},
    id: "health_1",
    openedAt: "2026-06-20T12:00:00.000Z",
    resolvedAt: null,
    severity: "warning",
    status: "open",
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.node_offline",
    ...input,
  };
}

function node(id: string, alias: string): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias,
    hostname: "node.local",
    id,
    interfaces: [],
    ipAddresses: ["10.0.0.10"],
    lastSeenAt: "2026-06-20T12:00:00.000Z",
    location: { room: "Council", site: "Town Hall" },
    status: "online",
    tags: [],
  };
}

function recording(id: string, name: string): RecordingSummary {
  return {
    cached: true,
    durationSeconds: 60,
    folder: "Council",
    healthStatus: "healthy",
    id,
    name,
    recordedAt: "2026-06-20T12:00:00.000Z",
    retentionPolicyId: "retention-keep-controller-cache",
    source: "schedule",
    status: "cached",
    tags: [],
    uploadPolicyId: "upload-policy-stub",
    watchdogPolicyId: "scheduled-voice-watchdog",
  };
}

function schedule(id: string, name: string): ScheduleSummary {
  return {
    enabled: true,
    folderTemplate: "Council",
    id,
    name,
    nextRunAt: "2026-06-21T12:00:00.000Z",
    nodeId: "node_1",
    recordingProfileId: "voice-mp3-vbr",
    recurrence: {
      interval: 1,
      endTime: "13:00",
      mode: "daily",
      startTime: "12:00",
    },
    retentionPolicyId: "retention-keep-controller-cache",
    room: "Council",
    tags: [],
    titleTemplate: "Council Daily",
    timezone: "UTC",
    uploadPolicyId: "upload-policy-stub",
    watchdogPolicyId: "scheduled-voice-watchdog",
  };
}
