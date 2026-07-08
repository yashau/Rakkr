import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ScheduleSummary } from "@rakkr/shared";
import type { AppBindings } from "../src/http-types.js";
import {
  allowPermission,
  createAuditStore,
  createNodeStore,
  createSettingsStore,
  denyMissingPermission,
  node,
  recordAuditEvent,
  recordingStore,
  registerScheduleRoutes,
  requestJson,
  schedule,
  scheduleList,
  scheduleStore,
  user,
} from "./schedule-routes-harness.js";

test("schedule routes deny users without required permissions", async () => {
  const auditStore = createAuditStore("");
  const deniedUser = user([]);
  const app = new Hono<AppBindings>();

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: deniedUser }),
    currentUser: () => deniedUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: denyMissingPermission(auditStore, deniedUser),
    scheduleStore: scheduleStore([schedule()]),
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [],
    settingsStore: createSettingsStore(),
  });

  const responses = await Promise.all([
    app.request("/api/v1/schedules"),
    app.request("/api/v1/schedules/export"),
    requestJson(app, "/api/v1/schedules/export", "POST", {
      scheduleIds: [schedule().id],
    }),
    app.request(`/api/v1/schedules/${schedule().id}`),
    app.request(`/api/v1/schedules/${schedule().id}/actions`),
    app.request(`/api/v1/schedules/${schedule().id}/occurrences`),
    requestJson(app, "/api/v1/schedules", "POST", {
      enabled: true,
      name: "Blocked Schedule",
      nodeId: node().id,
      room: "Council Room",
      timezone: "UTC",
    }),
    requestJson(app, `/api/v1/schedules/${schedule().id}`, "PATCH", {
      name: "Blocked Rename",
    }),
    app.request(`/api/v1/schedules/${schedule().id}/run-now`, { method: "POST" }),
    app.request(`/api/v1/schedules/${schedule().id}/skip-next`, { method: "POST" }),
    app.request(`/api/v1/schedules/${schedule().id}`, { method: "DELETE" }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => `${event.permission}:${event.action}`).sort(), [
    "schedule:manage:schedules.create",
    "schedule:manage:schedules.delete",
    "schedule:manage:schedules.run_now",
    "schedule:manage:schedules.skip_next",
    "schedule:manage:schedules.update",
    "schedule:read:schedules.actions.read",
    "schedule:read:schedules.detail.read",
    "schedule:read:schedules.export",
    "schedule:read:schedules.export_selected",
    "schedule:read:schedules.occurrences.read",
    "schedule:read:schedules.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === deniedUser.id));
});

test("schedule export returns filtered scoped csv and audits access", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read"]);
  const schedules = [
    schedule({
      captureBackend: "jack",
      enabled: true,
      id: "sched_export_visible",
      name: 'Council "Quoted" Sessions',
      nodeId: "node_export",
      room: "Council Chamber",
      tags: ["voice", "public"],
    }),
    schedule({
      captureBackend: "pipewire",
      enabled: true,
      id: "sched_export_other",
      name: "Archive Export",
      nodeId: "node_export",
      room: "Archive",
      tags: ["archive"],
    }),
  ];
  const store = scheduleStore(schedules);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const response = await app.request("/api/v1/schedules/export?search=quoted&captureBackend=jack");
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "schedules.export.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("content-disposition") ?? "", /rakkr-schedules-/);
  assert.match(csv, /^"id","name","enabled"/);
  assert.match(csv, /"sched_export_visible","Council ""Quoted"" Sessions"/);
  assert.doesNotMatch(csv, /sched_export_other/);
  assert.equal(event?.permission, "schedule:read");
  assert.equal(event?.target.id, "schedule_collection");
  assert.equal(event?.details.exportedCount, 1);
  assert.deepEqual(event?.details.filters, {
    captureBackend: "jack",
    captureInterfaceId: undefined,
    enabled: undefined,
    nodeId: undefined,
    search: "quoted",
  });
});

test("selected schedule export preserves request order and rejects hidden schedules", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read"]);
  const visibleA = schedule({ id: "sched_selected_a", name: "Selected A" });
  const visibleB = schedule({ id: "sched_selected_b", name: "Selected B" });
  const hidden = schedule({ id: "sched_selected_hidden", name: "Selected Hidden" });
  const store = scheduleStore([visibleA, visibleB, hidden]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [visibleA, visibleB],
    settingsStore: createSettingsStore(),
  });

  const selected = await requestJson(app, "/api/v1/schedules/export", "POST", {
    scheduleIds: [visibleB.id, visibleA.id, visibleB.id],
  });
  const csv = await selected.text();
  const hiddenResponse = await requestJson(app, "/api/v1/schedules/export", "POST", {
    scheduleIds: [visibleA.id, hidden.id],
  });
  const selectedEvent = (
    await auditStore.list({ action: "schedules.export_selected.succeeded" })
  )[0];
  const failedEvent = (await auditStore.list({ action: "schedules.export_selected.failed" }))[0];

  assert.equal(selected.status, 200);
  assert.ok(csv.indexOf(visibleB.id) < csv.indexOf(visibleA.id));
  assert.equal((csv.match(new RegExp(visibleB.id, "g")) ?? []).length, 1);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(selectedEvent?.details.requestedCount, 3);
  assert.equal(selectedEvent?.details.exportedCount, 2);
  assert.equal(selectedEvent?.correlationIds?.scheduleId1, visibleB.id);
  assert.equal(failedEvent?.outcome, "denied");
  assert.equal(failedEvent?.reason, "schedule_not_visible");
  assert.deepEqual(failedEvent?.details.hiddenIds, [hidden.id]);
});

test("schedule list route filters scoped schedules", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read"]);
  const schedules = [
    schedule({
      captureBackend: "jack",
      captureInterfaceId: "iface_jack",
      enabled: true,
      id: "sched_council",
      name: "Council Sessions",
      nodeId: "node_council",
      room: "Council Chamber",
      tags: ["voice", "public"],
    }),
    schedule({
      captureBackend: "pipewire",
      captureInterfaceId: "iface_pipewire",
      enabled: false,
      id: "sched_archive",
      name: "Archive Transfer",
      nodeId: "node_archive",
      room: "Records",
      tags: ["archive"],
    }),
    schedule({
      enabled: true,
      id: "sched_budget",
      name: "Budget Workshop",
      nodeId: "node_council",
      room: "Finance",
      tags: ["finance"],
    }),
  ];
  const store = scheduleStore(schedules);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const bySearch = await scheduleList(app, "?search=public");
  const byState = await scheduleList(app, "?enabled=false");
  const byNode = await scheduleList(app, "?nodeId=node_council");
  const byBackend = await scheduleList(app, "?captureBackend=pipewire");
  const byInterface = await scheduleList(app, "?captureInterfaceId=iface_jack");
  const events = await auditStore.list({ action: "schedules.read.succeeded" });
  const searchEvent = events.find((event) => event.details.filters?.search === "public");

  assert.deepEqual(
    bySearch.map((candidate) => candidate.id),
    ["sched_council"],
  );
  assert.deepEqual(
    byState.map((candidate) => candidate.id),
    ["sched_archive"],
  );
  assert.deepEqual(
    byNode.map((candidate) => candidate.id),
    ["sched_council", "sched_budget"],
  );
  assert.deepEqual(
    byBackend.map((candidate) => candidate.id),
    ["sched_archive"],
  );
  assert.deepEqual(
    byInterface.map((candidate) => candidate.id),
    ["sched_council"],
  );
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((event) => event.details.returnedCount).sort(), [1, 1, 1, 1, 2]);
  assert.deepEqual(searchEvent?.details.filters, {
    captureBackend: undefined,
    captureInterfaceId: undefined,
    enabled: undefined,
    nodeId: undefined,
    search: "public",
  });
  assert.equal(searchEvent?.permission, "schedule:read");
  assert.equal(searchEvent?.target.id, "schedule_collection");
});

test("schedule detail route returns scoped schedules only", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read"]);
  const visible = schedule({ id: "sched_visible", name: "Visible Detail" });
  const hidden = schedule({ id: "sched_hidden", name: "Hidden Detail" });
  const store = scheduleStore([visible, hidden]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [visible],
    settingsStore: createSettingsStore(),
  });

  const visibleResponse = await app.request(`/api/v1/schedules/${visible.id}`);
  const hiddenResponse = await app.request(`/api/v1/schedules/${hidden.id}`);
  const missingResponse = await app.request("/api/v1/schedules/sched_missing");
  const visibleBody = (await visibleResponse.json()) as { data: ScheduleSummary };
  const [successEvent] = await auditStore.list({ action: "schedules.detail.read.succeeded" });
  const failedEvents = await auditStore.list({ action: "schedules.detail.read.failed" });

  assert.equal(visibleResponse.status, 200);
  assert.equal(visibleBody.data.id, visible.id);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(missingResponse.status, 404);
  assert.equal(successEvent?.permission, "schedule:read");
  assert.equal(successEvent?.target.id, visible.id);
  assert.equal(successEvent?.target.name, visible.name);
  assert.equal(successEvent?.details.nodeId, visible.nodeId);
  assert.equal(successEvent?.details.enabled, visible.enabled);
  assert.deepEqual(failedEvents.map((event) => `${event.target.id}:${event.reason}`).sort(), [
    `${hidden.id}:schedule_not_found`,
    "sched_missing:schedule_not_found",
  ]);
});
