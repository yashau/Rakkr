import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { ScheduleStore } from "../src/schedule-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-schedule-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "recording-jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { registerScheduleRoutes } = await import("../src/schedule-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

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
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedSchedules: () => store.list(),
    settingsStore: createSettingsStore(),
  });

  const bySearch = await scheduleList(app, "?search=public");
  const byState = await scheduleList(app, "?enabled=false");
  const byNode = await scheduleList(app, "?nodeId=node_council");
  const byBackend = await scheduleList(app, "?captureBackend=pipewire");
  const byInterface = await scheduleList(app, "?captureInterfaceId=iface_jack");

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
});

test("schedule detail route returns scoped schedules only", async () => {
  const app = new Hono<AppBindings>();
  const currentUser = user(["schedule:read"]);
  const visible = schedule({ id: "sched_visible", name: "Visible Detail" });
  const hidden = schedule({ id: "sched_hidden", name: "Hidden Detail" });
  const store = scheduleStore([visible, hidden]);

  registerScheduleRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedSchedules: async () => [visible],
    settingsStore: createSettingsStore(),
  });

  const visibleResponse = await app.request(`/api/v1/schedules/${visible.id}`);
  const hiddenResponse = await app.request(`/api/v1/schedules/${hidden.id}`);
  const missingResponse = await app.request("/api/v1/schedules/sched_missing");
  const visibleBody = (await visibleResponse.json()) as { data: ScheduleSummary };

  assert.equal(visibleResponse.status, 200);
  assert.equal(visibleBody.data.id, visible.id);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(missingResponse.status, 404);
});

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

  assert.deepEqual(
    [occurrences.status, update.status, runNow.status, skipNext.status, deleted.status],
    [404, 404, 404, 404, 404],
  );
  assert.equal(stillHidden?.name, hidden.name);
  assert.deepEqual(recordingList, []);
  assert.deepEqual(failedEvents.map((event) => `${event.action}:${event.reason}`).sort(), [
    "schedules.delete.failed:schedule_not_found",
    "schedules.run_now.failed:schedule_not_found",
    "schedules.skip_next.failed:schedule_not_found",
    "schedules.update.failed:schedule_not_found",
  ]);
});

test("schedule action summary returns scoped readiness links and node context", async () => {
  const app = new Hono<AppBindings>();
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
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore: recordingStore(),
    requirePermission: allowPermission(),
    scheduleStore: store,
    scopedSchedules: async () => [visible],
    settingsStore: createSettingsStore(),
  });

  const visibleResponse = await app.request(`/api/v1/schedules/${visible.id}/actions`);
  const hiddenResponse = await app.request(`/api/v1/schedules/${hidden.id}/actions`);
  const body = (await visibleResponse.json()) as ScheduleActionsResponse;

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
    uploadPolicyId: "upload-policy-stub",
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
});

function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

async function scheduleList(app: Hono<AppBindings>, query = "") {
  const response = await app.request(`/api/v1/schedules${query}`);
  const body = (await response.json()) as { data: ScheduleSummary[] };

  assert.equal(response.status, 200);

  return body.data;
}

interface ScheduleActionsResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; reason?: string }>;
    links: Record<string, string | undefined>;
    node?: RecorderNode;
    schedule: ScheduleSummary;
  };
}

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const actor = input.actor ?? {
      id: input.auth?.user?.id ?? "anonymous",
      name: input.auth?.user?.name ?? "Anonymous",
      roles: input.auth?.user?.roles ?? [],
      type: "user" as const,
    };
    const event: AuditEvent = {
      action: input.action,
      actor,
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

function scheduleStore(schedules: ScheduleSummary[]): ScheduleStore {
  return {
    async create(schedule) {
      schedules.unshift(schedule);

      return schedule;
    },
    async delete(scheduleId) {
      const index = schedules.findIndex((candidate) => candidate.id === scheduleId);
      const [deleted] = index >= 0 ? schedules.splice(index, 1) : [];

      return deleted;
    },
    async find(scheduleId) {
      return schedules.find((candidate) => candidate.id === scheduleId);
    },
    async list() {
      return schedules;
    },
    async update(scheduleId, update) {
      const index = schedules.findIndex((candidate) => candidate.id === scheduleId);

      if (index < 0) {
        return undefined;
      }

      schedules[index] = { ...schedules[index], ...update };

      return schedules[index];
    },
  };
}

function recordingStore() {
  const recordings: RecordingSummary[] = [];

  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
    async delete(recordingId: string) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);
      const [deleted] = index >= 0 ? recordings.splice(index, 1) : [];

      return deleted;
    },
    async find(recordingId: string) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
  };
}

function user(permissions: Permission[] = ["schedule:read"]): CurrentUser {
  return {
    email: "schedule-viewer@example.com",
    groups: [],
    id: "user_schedule_viewer_test",
    name: "Schedule Viewer Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Schedule Node",
    hostname: "schedule-node",
    id: "node_schedule_test",
    interfaces: [],
    ipAddresses: ["10.0.0.60"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Council Room",
      site: "Main Site",
    },
    status: "online",
    tags: ["voice"],
    ...input,
  };
}

function schedule(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id: "sched_route_test",
    name: "Council Meeting",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: node().id,
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    room: "Council Room",
    tags: ["council"],
    timezone: "UTC",
    titleTemplate: "{{date}} Council Meeting",
    uploadPolicyId: "upload-policy-stub",
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...input,
  };
}
