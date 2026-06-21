import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentUser, HealthEvent, Permission } from "@rakkr/shared";

import {
  dashboardActiveHealthEvents,
  dashboardIncidentActions,
  dashboardPagePermissions,
  dashboardSelectedNodeId,
} from "./dashboard-page-helpers";

test("dashboard page reads and meters require node read permission", () => {
  assert.deepEqual(dashboardPagePermissions(undefined), {
    canAcknowledgeHealth: false,
    canRead: false,
    canReadHealth: false,
    canReadMeters: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["metrics:read"])), {
    canAcknowledgeHealth: false,
    canRead: false,
    canReadHealth: false,
    canReadMeters: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["node:read"])), {
    canAcknowledgeHealth: false,
    canRead: true,
    canReadHealth: false,
    canReadMeters: true,
  });
  assert.deepEqual(dashboardPagePermissions(user(["health:read"])), {
    canAcknowledgeHealth: false,
    canRead: false,
    canReadHealth: true,
    canReadMeters: false,
  });
  assert.deepEqual(dashboardPagePermissions(user(["health:acknowledge"])), {
    canAcknowledgeHealth: true,
    canRead: false,
    canReadHealth: false,
    canReadMeters: false,
  });
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
