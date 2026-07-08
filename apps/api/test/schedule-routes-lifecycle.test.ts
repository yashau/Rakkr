import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { RecordingSummary, ScheduleSummary } from "@rakkr/shared";
import type { AppBindings } from "../src/http-types.js";
import {
  allowPermission,
  createAuditStore,
  createNodeStore,
  createSettingsStore,
  node,
  recordAuditEvent,
  recordingStore,
  registerScheduleRoutes,
  requestJson,
  schedule,
  scheduleStore,
  user,
} from "./schedule-routes-harness.js";

test("schedule occurrence and lifecycle routes only operate on scoped schedules", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:read", "schedule:manage"]);
  const visible = schedule({ id: "sched_visible_lifecycle", name: "Visible Lifecycle" });
  const hidden = schedule({ id: "sched_hidden_lifecycle", name: "Hidden Lifecycle" });
  const store = scheduleStore([visible, hidden]);
  const recordings = recordingStore();

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordings,
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [node()],
    scopedSchedules: async () => [visible],
    settingsStore: createSettingsStore(),
  });

  const occurrences = await app.request(`/api/v1/schedules/${hidden.id}/occurrences`);
  const update = await requestJson(app, `/api/v1/schedules/${hidden.id}`, "PATCH", {
    name: "Hidden Mutated",
  });
  const runNow = await app.request(`/api/v1/schedules/${hidden.id}/run-now`, { method: "POST" });
  const skipNext = await app.request(`/api/v1/schedules/${hidden.id}/skip-next`, {
    method: "POST",
  });
  const deleted = await app.request(`/api/v1/schedules/${hidden.id}`, { method: "DELETE" });
  const stillHidden = await store.find(hidden.id);
  const recordingList = await recordings.list();
  const failedEvents = await auditStore.list({ outcome: "failed" });
  const readFailures = failedEvents.filter((event) => event.permission === "schedule:read");
  const manageFailures = failedEvents.filter((event) => event.permission === "schedule:manage");

  assert.deepEqual(
    [occurrences.status, update.status, runNow.status, skipNext.status, deleted.status],
    [404, 404, 404, 404, 404],
  );
  assert.equal(stillHidden?.name, hidden.name);
  assert.deepEqual(recordingList, []);
  assert.deepEqual(
    readFailures.map((event) => `${event.action}:${event.reason}`),
    ["schedules.occurrences.read.failed:schedule_not_found"],
  );
  assert.deepEqual(manageFailures.map((event) => `${event.action}:${event.reason}`).sort(), [
    "schedules.delete.failed:schedule_not_found",
    "schedules.run_now.failed:schedule_not_found",
    "schedules.skip_next.failed:schedule_not_found",
    "schedules.update.failed:schedule_not_found",
  ]);
});

test("disabled schedule run-now is rejected and audited", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:manage", "schedule:read"]);
  const disabled = schedule({
    enabled: false,
    id: `sched_disabled_run_${randomUUID()}`,
    nodeId: node().id,
  });
  const store = scheduleStore([disabled]);

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
    scopedSchedules: async () => [disabled],
    settingsStore: createSettingsStore(),
  });

  const response = await app.request(`/api/v1/schedules/${disabled.id}/run-now`, {
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "schedules.run_now.failed" });

  assert.equal(response.status, 409);
  assert.equal(event?.reason, "schedule_disabled");
  assert.equal(event?.target.id, disabled.id);
});

test("schedule work routes only operate on scoped visible nodes", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["schedule:manage", "schedule:read"]);
  const visibleNode = node({ id: "node_schedule_visible" });
  const hiddenNode = node({ id: "node_schedule_hidden" });
  const visible = schedule({
    id: "sched_visible_node_scope",
    nodeId: visibleNode.id,
  });
  const hiddenNodeSchedule = schedule({
    id: "sched_hidden_node_scope",
    nodeId: hiddenNode.id,
  });
  const store = scheduleStore([visible, hiddenNodeSchedule]);
  const recordings = recordingStore();

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([visibleNode, hiddenNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordings,
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [visibleNode],
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const createHidden = await requestJson(app, "/api/v1/schedules", "POST", {
    enabled: true,
    folderTemplate: "Hidden/{{date}}",
    name: "Hidden Node Schedule",
    nodeId: hiddenNode.id,
    recordingProfileId: "voice-mp3-vbr",
    room: "Hidden Room",
    timezone: "UTC",
    titleTemplate: "{{date}} Hidden Node Schedule",
    watchdogPolicyId: "scheduled-voice-watchdog",
  });
  const updateHidden = await requestJson(app, `/api/v1/schedules/${visible.id}`, "PATCH", {
    nodeId: hiddenNode.id,
  });
  const runHidden = await app.request(`/api/v1/schedules/${hiddenNodeSchedule.id}/run-now`, {
    method: "POST",
  });
  const failedEvents = await auditStore.list({
    outcome: "failed",
    permission: "schedule:manage",
  });

  assert.equal(createHidden.status, 409);
  assert.equal(updateHidden.status, 409);
  assert.equal(runHidden.status, 409);
  assert.equal((await store.find(visible.id))?.nodeId, visibleNode.id);
  assert.equal(
    (await store.list()).some((candidate) => candidate.name === "Hidden Node Schedule"),
    false,
  );
  assert.equal((await recordings.list()).length, 0);
  assert.deepEqual(failedEvents.map((event) => `${event.action}:${event.reason}`).sort(), [
    "schedules.create.failed:schedule_node_not_found",
    "schedules.run_now.failed:schedule_node_not_found",
    "schedules.update.failed:schedule_node_not_found",
  ]);
  assert.equal(
    failedEvents.find((event) => event.action === "schedules.run_now.failed")?.target.id,
    hiddenNodeSchedule.id,
  );
});

test("schedule routes create update run-now and skip-next with audit events", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = user(["recording:read", "schedule:read", "schedule:manage"]);
  const routeInterfaceId = "iface_route_jack";
  const routeNode = node({
    id: `node_schedule_ops_${randomUUID()}`,
    interfaces: [
      {
        alias: "JACK Route",
        backend: "jack",
        channelCount: 2,
        channels: [
          { alias: "Left", index: 1 },
          { alias: "Right", index: 2 },
        ],
        id: routeInterfaceId,
        sampleRates: [48_000],
        systemName: "jack:route",
        systemRef: "jack:route",
      },
    ],
  });
  const schedules: ScheduleSummary[] = [];
  const store = scheduleStore(schedules);
  const recordings = recordingStore();
  const scheduleId = `sched_route_ops_${randomUUID()}`;

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([routeNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: recordings,
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedNodes: async () => [routeNode],
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const invalidInterface = await requestJson(app, "/api/v1/schedules", "POST", {
    enabled: true,
    captureInterfaceId: "missing_interface",
    folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
    name: "Invalid Interface",
    nodeId: routeNode.id,
    recordingProfileId: "voice-mp3-vbr",
    room: "Council Room",
    timezone: "UTC",
    titleTemplate: "{{date}}_{{time}}_{{schedule.name}}",
    watchdogPolicyId: "scheduled-voice-watchdog",
  });
  const created = await requestJson(app, "/api/v1/schedules", "POST", {
    captureBackend: "jack",
    captureInterfaceId: routeInterfaceId,
    enabled: true,
    folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
    id: scheduleId,
    name: "Council Route Test",
    nodeId: routeNode.id,
    recurrence: {
      endTime: "10:00",
      interval: 1,
      mode: "daily",
      startEarlySeconds: 300,
      startTime: "09:00",
      stopLateSeconds: 120,
    },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    room: "Council Room",
    tags: ["voice", "route", "voice"],
    timezone: "UTC",
    titleTemplate: "{{date}}_{{time}}_{{schedule.name}}",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
  });
  const createdBody = (await created.json()) as { data: ScheduleSummary };
  const updated = await requestJson(app, `/api/v1/schedules/${scheduleId}`, "PATCH", {
    name: "Council Route Test Updated",
    tags: ["updated", "voice", "updated"],
  });
  const updatedBody = (await updated.json()) as { data: ScheduleSummary };
  const occurrences = await app.request(`/api/v1/schedules/${scheduleId}/occurrences?limit=2`);
  const runNow = await app.request(`/api/v1/schedules/${scheduleId}/run-now`, { method: "POST" });
  const runNowBody = (await runNow.json()) as {
    data: RecordingSummary;
    job: {
      command: { captureBackend?: string; captureDevice: string; captureInterfaceId?: string };
      recordingId: string;
    };
    segments: Array<{ recordingId: string }>;
  };
  const beforeSkip = await store.find(scheduleId);
  const skipped = await app.request(`/api/v1/schedules/${scheduleId}/skip-next`, {
    method: "POST",
  });
  const skippedBody = (await skipped.json()) as { data: ScheduleSummary };
  const succeededAudits = await auditStore.list({
    outcome: "succeeded",
    permission: "schedule:manage",
  });
  const runNowAudit = succeededAudits.find(
    (event) => event.action === "schedules.run_now.succeeded",
  );
  const [occurrencesAudit] = await auditStore.list({
    action: "schedules.occurrences.read.succeeded",
  });

  assert.equal(invalidInterface.status, 409);
  assert.equal(created.status, 201);
  assert.equal(updated.status, 200);
  assert.equal(occurrences.status, 200);
  assert.equal(runNow.status, 202);
  assert.equal(skipped.status, 200);
  assert.equal(createdBody.data.id, scheduleId);
  assert.equal(createdBody.data.captureBackend, "jack");
  assert.equal(createdBody.data.captureInterfaceId, routeInterfaceId);
  assert.deepEqual(createdBody.data.tags, ["voice", "route"]);
  assert.equal(updatedBody.data.name, "Council Route Test Updated");
  assert.deepEqual(updatedBody.data.tags, ["updated", "voice"]);
  assert.equal(runNowBody.data.scheduleId, scheduleId);
  assert.equal(runNowBody.data.retentionPolicyId, "retention-keep-controller-cache");
  assert.equal(runNowBody.job.command.captureBackend, "jack");
  assert.equal(runNowBody.job.command.captureDevice, "jack:route");
  assert.equal(runNowBody.job.command.captureInterfaceId, routeInterfaceId);
  assert.equal(runNowBody.job.recordingId, runNowBody.data.id);
  assert.deepEqual(
    runNowBody.segments.map((segment) => segment.recordingId),
    [runNowBody.data.id],
  );
  assert.equal((await recordings.list())[0]?.source, "schedule");
  assert.notEqual(skippedBody.data.nextRunAt, beforeSkip?.nextRunAt);
  assert.ok(
    skippedBody.data.recurrence.exceptions?.some((exception) => exception.action === "skip"),
  );
  assert.deepEqual(succeededAudits.map((event) => event.action).sort(), [
    "schedules.create.succeeded",
    "schedules.run_now.succeeded",
    "schedules.skip_next.succeeded",
    "schedules.update.succeeded",
  ]);
  assert.equal(runNowAudit?.correlationIds?.scheduleId, scheduleId);
  assert.equal(runNowAudit?.details.captureBackend, "jack");
  assert.equal(runNowAudit?.details.captureInterfaceId, routeInterfaceId);
  assert.equal(runNowAudit?.after?.recordingId, runNowBody.data.id);
  assert.equal(occurrencesAudit?.permission, "schedule:read");
  assert.equal(occurrencesAudit?.target.id, scheduleId);
  assert.equal(occurrencesAudit?.details.requestedLimit, 2);
  assert.equal(occurrencesAudit?.details.occurrenceCount, 2);
});
