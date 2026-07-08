import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AppBindings } from "../src/http-types.js";
import {
  type ScheduleActionsResponse,
  allowPermission,
  createAuditStore,
  createNodeStore,
  createSettingsStore,
  node,
  recordAuditEvent,
  recordingStore,
  registerScheduleRoutes,
  schedule,
  scheduleStore,
  user,
} from "./schedule-routes-harness.js";

test("schedule action summary returns scoped readiness links and node context", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read", "schedule:manage"]);
  const visible = schedule({
    id: `sched_actions_visible_${randomUUID()}`,
    name: "Visible Actions",
    nodeId: "node_schedule_actions",
  });
  const hidden = schedule({ id: `sched_actions_hidden_${randomUUID()}` });
  const store = scheduleStore([visible, hidden]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node({ id: visible.nodeId })]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node({ id: visible.nodeId })],
    scopedSchedules: async () => [visible],
    settingsStore: createSettingsStore(),
  });

  const visibleResponse = await app.request(`/api/v1/schedules/${visible.id}/actions`);
  const hiddenResponse = await app.request(`/api/v1/schedules/${hidden.id}/actions`);
  const body = (await visibleResponse.json()) as ScheduleActionsResponse;
  const [succeededEvent] = await auditStore.list({
    action: "schedules.actions.read.succeeded",
  });
  const [failedEvent] = await auditStore.list({ action: "schedules.actions.read.failed" });

  assert.equal(visibleResponse.status, 200);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(body.data.schedule.id, visible.id);
  assert.equal(body.data.node?.id, visible.nodeId);
  assert.equal(body.data.actions.edit.enabled, true);
  assert.equal(body.data.actions.delete.enabled, true);
  assert.equal(body.data.actions.runNow.enabled, true);
  assert.equal(body.data.actions.skipNext.enabled, true);
  assert.equal(body.data.actions.occurrences.enabled, true);
  assert.equal(body.data.links.runNow, `/api/v1/schedules/${visible.id}/run-now`);
  assert.equal(body.data.links.occurrences, `/api/v1/schedules/${visible.id}/occurrences`);
  assert.equal(succeededEvent?.outcome, "succeeded");
  assert.equal(succeededEvent?.permission, "schedule:read");
  assert.equal(succeededEvent?.target.id, visible.id);
  assert.equal(succeededEvent?.target.name, visible.name);
  assert.equal(succeededEvent?.details.nodeAvailable, true);
  assert.equal(succeededEvent?.details.scheduleEnabled, true);
  assert.equal(succeededEvent?.details.visibleActionCount, 5);
  assert.equal(failedEvent?.outcome, "failed");
  assert.equal(failedEvent?.permission, "schedule:read");
  assert.equal(failedEvent?.reason, "schedule_not_found");
  assert.equal(failedEvent?.target.id, hidden.id);
});

test("schedule action summary reports lifecycle blockers for disabled schedules", async () => {
  const app = new Hono<AppBindings>();
  const currentUser = user(["schedule:read", "schedule:manage"]);
  const disabled = schedule({
    enabled: false,
    id: `sched_actions_disabled_${randomUUID()}`,
    name: "Disabled Actions",
  });
  const store = scheduleStore([disabled]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [disabled],
    settingsStore: createSettingsStore(),
  });

  const response = await app.request(`/api/v1/schedules/${disabled.id}/actions`);
  const body = (await response.json()) as ScheduleActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.actions.runNow.enabled, false);
  assert.equal(body.data.actions.runNow.reason, "schedule_disabled");
  assert.equal(body.data.actions.skipNext.enabled, false);
  assert.equal(body.data.actions.skipNext.reason, "schedule_disabled");
});

test("schedule action summary hides out-of-scope node context and readiness", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read", "schedule:manage"]);
  const visibleNode = node({ id: "node_schedule_action_visible" });
  const hiddenNode = node({ id: "node_schedule_action_hidden" });
  const scheduleOnHiddenNode = schedule({
    id: "sched_action_hidden_node",
    name: "Hidden Node Action Summary",
    nodeId: hiddenNode.id,
  });
  const store = scheduleStore([scheduleOnHiddenNode]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([visibleNode, hiddenNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [visibleNode],
    scopedSchedules: async () => [scheduleOnHiddenNode],
    settingsStore: createSettingsStore(),
  });

  const response = await app.request(`/api/v1/schedules/${scheduleOnHiddenNode.id}/actions`);
  const body = (await response.json()) as ScheduleActionsResponse;
  const [event] = await auditStore.list({ action: "schedules.actions.read.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.data.schedule.id, scheduleOnHiddenNode.id);
  assert.equal(body.data.node, undefined);
  assert.equal(body.data.actions.runNow.enabled, false);
  assert.equal(body.data.actions.runNow.reason, "schedule_node_not_found");
  assert.equal(body.data.actions.skipNext.enabled, true);
  assert.equal(event?.details.nodeAvailable, false);
  assert.equal(event?.target.id, scheduleOnHiddenNode.id);
});
