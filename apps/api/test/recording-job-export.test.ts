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
  MeterFrame,
  RecordingJob,
  RecordingProfile,
  RecordingSummary,
} from "@rakkr/shared";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-job-export-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(routeRoot, "retention-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { filterRecordingJobsForExport, recordingJobsCsv } =
  await import("../src/recording-job-export.js");
const { createRecordingJob, failRecordingJob } = await import("../src/recording-jobs.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording job export helpers filter and render csv", () => {
  const visibleJob = job({
    command: { ...job().command, captureBackend: "pipewire", captureDevice: "hw:EXPORT,0" },
    createdAt: "2026-06-20T12:00:00.000Z",
    id: "job_export_visible",
    nodeId: "node_export_visible",
    status: "queued",
  });
  const hiddenByStatus = job({
    command: { ...job().command, captureDevice: "hw:EXPORT,1" },
    createdAt: "2026-06-20T12:30:00.000Z",
    id: "job_export_failed",
    nodeId: "node_export_visible",
    status: "failed",
  });
  const hiddenBySearch = job({
    command: { ...job().command, captureDevice: "hw:OTHER,0" },
    createdAt: "2026-06-21T12:00:00.000Z",
    id: "job_other",
    nodeId: "node_export_hidden",
    status: "queued",
  });

  const filtered = filterRecordingJobsForExport([visibleJob, hiddenByStatus, hiddenBySearch], {
    createdFrom: "2026-06-20T00:00:00.000Z",
    createdTo: "2026-06-20T23:59:59.999Z",
    nodeId: "node_export_visible",
    search: "export",
    status: "queued",
  });
  const csv = recordingJobsCsv(filtered);

  assert.deepEqual(
    filtered.map((recordingJob) => recordingJob.id),
    ["job_export_visible"],
  );
  assert.match(csv, /^id,recordingId,nodeId,status,claimedBy/m);
  assert.match(csv, /captureBackend/);
  assert.match(csv, /job_export_visible,rec_1,node_export_visible,queued/);
  assert.match(csv, /pipewire,"hw:EXPORT,0"/);
  assert.doesNotMatch(csv, /job_export_failed/);
  assert.doesNotMatch(csv, /job_other/);
});

test("recording job list route filters scoped jobs by status search node and backend", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const prefix = `filter_${randomUUID()}`;
  const recordings = [
    recordingSummary({ id: `rec_${prefix}_jack`, nodeId: `${prefix}_node_jack` }),
    recordingSummary({ id: `rec_${prefix}_pipewire`, nodeId: `${prefix}_node_pipewire` }),
    recordingSummary({ id: `rec_${prefix}_failed`, nodeId: `${prefix}_node_failed` }),
  ];
  const recordingStore = memoryRecordingStore(recordings);
  const jackJob = await createRecordingJob(recordings[0] as RecordingSummary, {
    captureBackend: "jack",
    captureDevice: `${prefix}:system:capture_1`,
    captureInterfaceId: `${prefix}_iface_jack`,
  });

  await createRecordingJob(recordings[1] as RecordingSummary, {
    captureBackend: "pipewire",
    captureDevice: `${prefix}:alsa_input.usb-recorder`,
    captureInterfaceId: `${prefix}_iface_pipewire`,
  });
  const failedJob = await createRecordingJob(recordings[2] as RecordingSummary, {
    captureBackend: "jack",
    captureDevice: `${prefix}:system:capture_2`,
    captureInterfaceId: `${prefix}_iface_other`,
  });

  await failRecordingJob(failedJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });
  const response = await app.request(
    `/api/v1/recording-jobs?search=${prefix}&status=queued&nodeId=${prefix}_node_jack&captureBackend=jack&captureInterfaceId=${prefix}_iface_jack&createdFrom=2026-06-01T00%3A00%3A00.000Z&createdTo=2099-12-31T23%3A59%3A59.999Z`,
  );
  const body = (await response.json()) as { data: RecordingJob[] };
  const invalidResponse = await app.request("/api/v1/recording-jobs?createdFrom=2026-06-20");

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.read");
  assert.deepEqual(
    body.data.map((recordingJob) => recordingJob.id),
    [jackJob.id],
  );
  assert.equal(invalidResponse.status, 400);
});

test("recording job detail route returns only scoped jobs", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const visible = recordingSummary({ id: `rec_detail_visible_${randomUUID()}` });
  const hidden = recordingSummary({ id: `rec_detail_hidden_${randomUUID()}` });
  const recordingStore = memoryRecordingStore([visible, hidden]);
  const visibleJob = await createRecordingJob(visible);
  const hiddenJob = await createRecordingJob(hidden);
  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
    visibleRecordingIds: [visible.id],
  });

  const visibleResponse = await app.request(`/api/v1/recording-jobs/${visibleJob.id}`);
  const hiddenResponse = await app.request(`/api/v1/recording-jobs/${hiddenJob.id}`);
  const missingResponse = await app.request("/api/v1/recording-jobs/job_missing_detail");
  const visibleBody = (await visibleResponse.json()) as { data: RecordingJob };

  assert.equal(visibleResponse.status, 200);
  assert.equal(visibleBody.data.id, visibleJob.id);
  assert.equal(visibleBody.data.recordingId, visible.id);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(permissionCalls.at(-3), {
    action: "recording_jobs.detail.read",
    permission: "recording:read",
    target: { id: visible.id, type: "recording" },
  });
  assert.deepEqual(permissionCalls.at(-2), {
    action: "recording_jobs.detail.read",
    permission: "recording:read",
    target: { id: hidden.id, type: "recording" },
  });
  assert.deepEqual(permissionCalls.at(-1), {
    action: "recording_jobs.detail.read",
    permission: "recording:read",
    target: { id: "job_missing_detail", type: "recording_job" },
  });
});

test("recording job detail route lets controller bearer reads pass agent route", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([recordingSummary()]);
  const permissionCalls: PermissionCall[] = [];
  const job = await createRecordingJob((await recordingStore.list())[0]!);

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: memorySettingsStore(),
  });
  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: user() }),
    currentUser: () => user(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => [],
    scopedRecordings: () => recordingStore.list(),
    settingsStore: memorySettingsStore(),
  });

  const response = await app.request(`/api/v1/recording-jobs/${job.id}`, {
    headers: { authorization: "Bearer user-token" },
  });
  const body = (await response.json()) as { data: RecordingJob };
  const missingTokenEvents = await auditStore.list({
    action: "recording_jobs.read_one.failed",
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.id, job.id);
  assert.equal(body.data.recordingId, recordingSummary().id);
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.detail.read");
  assert.equal(missingTokenEvents.length, 0);
});

test("recording job action summary returns readiness links and payloads", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recording = recordingSummary({ id: `rec_job_actions_${randomUUID()}` });
  const recordingStore = memoryRecordingStore([recording]);
  const failedJob = await createRecordingJob(recording);

  await failRecordingJob(failedJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls,
    permissions: ["recording:control", "recording:read"],
    recordingStore,
  });

  const response = await app.request(`/api/v1/recording-jobs/${failedJob.id}/actions`);
  const body = (await response.json()) as RecordingJobActionsResponse;
  const [auditEvent] = await auditStore.list({
    action: "recording_jobs.actions.read.succeeded",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "recording_jobs.actions.read",
    permission: "recording:read",
    target: { id: recording.id, type: "recording" },
  });
  assert.equal(body.data.job.id, failedJob.id);
  assert.equal(body.data.recording?.id, recording.id);
  assert.equal(body.data.retryConflict, undefined);
  assert.equal(body.data.actions.detail.enabled, true);
  assert.equal(body.data.actions.exportSelected.enabled, true);
  assert.deepEqual(body.data.actions.exportSelected.payload, { jobIds: [failedJob.id] });
  assert.equal(body.data.actions.retry.enabled, true);
  assert.equal(body.data.actions.retry.href, `/api/v1/recording-jobs/${failedJob.id}/retry`);
  assert.equal(body.data.actions.stop.enabled, false);
  assert.equal(body.data.actions.stop.reason, "recording_job_not_stoppable");
  assert.deepEqual(body.data.actions.stop.payload, { jobIds: [failedJob.id] });
  assert.equal(auditEvent?.outcome, "succeeded");
  assert.equal(auditEvent?.permission, "recording:read");
  assert.equal(auditEvent?.target.id, failedJob.id);
  assert.equal(auditEvent?.target.type, "recording_job");
  assert.equal(auditEvent?.correlationIds?.recordingId, recording.id);
  assert.equal(auditEvent?.details.recordingAvailable, true);
  assert.equal(auditEvent?.details.status, "failed");
  assert.equal(auditEvent?.details.visibleActionCount, 4);
});

test("recording job action summary uses scoped recording context for readiness", async () => {
  const auditStore = createAuditStore("");
  const scopedRecording = recordingSummary({
    id: `rec_job_scoped_context_${randomUUID()}`,
    name: "Scoped Recording Context",
  });
  const rawRecording = recordingSummary({
    id: scopedRecording.id,
    name: "Raw Recording Context",
  });
  const recordingStore = memoryRecordingStore([rawRecording]);
  const failedJob = await createRecordingJob(scopedRecording);

  await failRecordingJob(failedJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls: [],
    permissions: ["recording:control", "recording:read"],
    recordingStore,
    scopedRecordingSnapshots: [scopedRecording],
  });

  const response = await app.request(`/api/v1/recording-jobs/${failedJob.id}/actions`);
  const body = (await response.json()) as RecordingJobActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.job.id, failedJob.id);
  assert.equal(body.data.recording?.id, scopedRecording.id);
  assert.equal(body.data.recording?.name, "Scoped Recording Context");
  assert.equal(body.data.actions.retry.enabled, true);
  assert.equal(body.data.actions.stop.enabled, false);
  assert.equal(body.data.actions.stop.reason, "recording_job_not_stoppable");
});

test("recording job action summary explains lifecycle and dependency blockers", async () => {
  const auditStore = createAuditStore("");
  const recording = recordingSummary({ id: `rec_job_blockers_${randomUUID()}` });
  const recordingStore = memoryRecordingStore([recording]);
  const queuedJob = await createRecordingJob(recording);
  const failedJob = await createRecordingJob(recording);

  await failRecordingJob(failedJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls: [],
    permissions: ["recording:control", "recording:read"],
    recordingStore,
  });

  const queuedResponse = await app.request(`/api/v1/recording-jobs/${queuedJob.id}/actions`);
  const failedResponse = await app.request(`/api/v1/recording-jobs/${failedJob.id}/actions`);
  const queuedBody = (await queuedResponse.json()) as RecordingJobActionsResponse;
  const failedBody = (await failedResponse.json()) as RecordingJobActionsResponse;

  assert.equal(queuedResponse.status, 200);
  assert.equal(queuedBody.data.actions.stop.enabled, true);
  assert.equal(queuedBody.data.actions.retry.enabled, false);
  assert.equal(queuedBody.data.actions.retry.reason, "recording_job_not_retryable");
  assert.equal(failedResponse.status, 200);
  assert.equal(failedBody.data.actions.retry.enabled, false);
  assert.equal(failedBody.data.actions.retry.reason, "active_job_exists");
  assert.equal(failedBody.data.retryConflict?.id, queuedJob.id);
});

test("recording job action summary reports missing permission before lifecycle readiness", async () => {
  const auditStore = createAuditStore("");
  const recording = recordingSummary({ id: `rec_job_permission_${randomUUID()}` });
  const recordingStore = memoryRecordingStore([recording]);
  const failedJob = await createRecordingJob(recording);

  await failRecordingJob(failedJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls: [],
    permissions: ["recording:read"],
    recordingStore,
  });

  const response = await app.request(`/api/v1/recording-jobs/${failedJob.id}/actions`);
  const body = (await response.json()) as RecordingJobActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.actions.detail.enabled, true);
  assert.equal(body.data.actions.retry.enabled, false);
  assert.equal(body.data.actions.retry.reason, "missing_permission");
  assert.equal(body.data.actions.stop.enabled, false);
  assert.equal(body.data.actions.stop.reason, "missing_permission");
});

test("recording job action summary hides jobs outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const visible = recordingSummary({ id: `rec_job_action_visible_${randomUUID()}` });
  const hidden = recordingSummary({ id: `rec_job_action_hidden_${randomUUID()}` });
  const recordingStore = memoryRecordingStore([visible, hidden]);
  const hiddenJob = await createRecordingJob(hidden);
  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
    visibleRecordingIds: [visible.id],
  });

  const response = await app.request(`/api/v1/recording-jobs/${hiddenJob.id}/actions`);
  const [auditEvent] = await auditStore.list({ action: "recording_jobs.actions.read.failed" });

  assert.equal(response.status, 404);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "recording_jobs.actions.read",
    permission: "recording:read",
    target: { id: hidden.id, type: "recording" },
  });
  assert.equal(auditEvent?.outcome, "failed");
  assert.equal(auditEvent?.permission, "recording:read");
  assert.equal(auditEvent?.reason, "recording_job_not_found");
  assert.equal(auditEvent?.target.id, hiddenJob.id);
  assert.equal(auditEvent?.target.type, "recording_job");
});

test("recording job export route is RBAC-gated and audited", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore: memoryRecordingStore([]),
  });

  const response = await app.request(
    "/api/v1/recording-jobs/export?status=queued&nodeId=node_export_jack&search=room&captureBackend=jack&captureInterfaceId=iface_export_jack&createdFrom=2026-06-20T00%3A00%3A00.000Z&createdTo=2026-06-20T23%3A59%3A59.999Z",
  );
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "recording_jobs.export.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.export");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "recording_job_collection",
    type: "recording_collection",
  });
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="rakkr-recording-jobs-/,
  );
  assert.match(csv, /^id,recordingId,nodeId,status,claimedBy/m);
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.details.exportedCount, 0);
  assert.deepEqual(event?.details.filters, {
    captureBackend: "jack",
    captureInterfaceId: "iface_export_jack",
    createdFrom: "2026-06-20T00:00:00.000Z",
    createdTo: "2026-06-20T23:59:59.999Z",
    nodeId: "node_export_jack",
    search: "room",
    status: "queued",
  });
});

test("recording job selected export preserves requested order and audits selection", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recordings = [
    recordingSummary({ id: `rec_export_selected_a_${randomUUID()}` }),
    recordingSummary({ id: `rec_export_selected_b_${randomUUID()}` }),
  ];
  const recordingStore = memoryRecordingStore(recordings);
  const firstJob = await createRecordingJob(recordings[0] as RecordingSummary, {
    captureDevice: "hw:Selected,1",
  });
  const secondJob = await createRecordingJob(recordings[1] as RecordingSummary, {
    captureDevice: "hw:Selected,2",
  });
  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });
  const response = await app.request("/api/v1/recording-jobs/export", {
    body: JSON.stringify({ jobIds: [secondJob.id, firstJob.id, secondJob.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "recording_jobs.export_selected.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.export_selected");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "recording_job_collection",
    type: "recording_collection",
  });
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="rakkr-recording-jobs-/,
  );
  assert(csv.indexOf(secondJob.id) < csv.indexOf(firstJob.id));
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.target.id, "recording_job_collection");
  assert.equal(event?.details.requestedCount, 3);
  assert.equal(event?.details.exportedCount, 2);
  assert.deepEqual(event?.correlationIds, {
    jobId1: secondJob.id,
    jobId2: firstJob.id,
  });
});

test("recording job selected export rejects hidden jobs before exporting", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const visible = recordingSummary({ id: `rec_export_visible_${randomUUID()}` });
  const hidden = recordingSummary({ id: `rec_export_hidden_${randomUUID()}` });
  const recordingStore = memoryRecordingStore([visible, hidden]);
  const visibleJob = await createRecordingJob(visible);
  const hiddenJob = await createRecordingJob(hidden);
  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
    visibleRecordingIds: [visible.id],
  });
  const response = await app.request("/api/v1/recording-jobs/export", {
    body: JSON.stringify({ jobIds: [visibleJob.id, hiddenJob.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recording_jobs.export_selected.failed" });

  assert.equal(response.status, 404);
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.export_selected");
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.reason, "recording_job_not_visible");
  assert.deepEqual(event?.details.hiddenIds, [hiddenJob.id]);
  assert.deepEqual(event?.details.jobIds, [visibleJob.id, hiddenJob.id]);
});

test("recording job retry route is RBAC-gated audited and resets recording state", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recording = recordingSummary({
    cachePath: path.join(routeRoot, "stale.wav"),
    cached: true,
    checksum: "stale-checksum",
    durationSeconds: 12,
    healthStatus: "critical",
    id: `rec_retry_${randomUUID()}`,
    status: "failed",
  });
  const recordingStore = memoryRecordingStore([recording]);
  const sourceJob = await createRecordingJob(recording, {
    captureDevice: "hw:Retry,0",
  });

  await failRecordingJob(sourceJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });
  const response = await app.request(`/api/v1/recording-jobs/${sourceJob.id}/retry`, {
    method: "POST",
  });
  const body = (await response.json()) as { data: RecordingJob };
  const updatedRecording = await recordingStore.find(recording.id);
  const [event] = await auditStore.list({ action: "recording_jobs.retry.succeeded" });

  assert.equal(response.status, 201);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:control");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.retry");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: recording.id,
    type: "recording",
  });
  assert.notEqual(body.data.id, sourceJob.id);
  assert.equal(body.data.status, "queued");
  assert.equal(body.data.recordingId, recording.id);
  assert.equal(body.data.command.captureDevice, "hw:Retry,0");
  assert.equal(updatedRecording?.status, "recording");
  assert.equal(updatedRecording?.cached, false);
  assert.equal(updatedRecording?.cachePath, undefined);
  assert.equal(updatedRecording?.checksum, undefined);
  assert.equal(updatedRecording?.durationSeconds, 0);
  assert.equal(updatedRecording?.healthStatus, "unknown");
  assert.equal(event?.permission, "recording:control");
  assert.equal(event?.target.id, recording.id);
  assert.equal(event?.before?.jobId, sourceJob.id);
  assert.equal(event?.after?.jobId, body.data.id);
  assert.equal(event?.correlationIds?.sourceJobId, sourceJob.id);
  assert.equal(event?.correlationIds?.retryJobId, body.data.id);
});

test("recording job bulk retry route retries visible terminal jobs and audits collection", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recordings = [
    recordingSummary({
      cached: true,
      checksum: "old-a",
      durationSeconds: 60,
      healthStatus: "critical",
      id: `rec_bulk_retry_a_${randomUUID()}`,
      status: "failed",
    }),
    recordingSummary({
      cached: true,
      checksum: "old-b",
      durationSeconds: 30,
      healthStatus: "warning",
      id: `rec_bulk_retry_b_${randomUUID()}`,
      status: "cancelled",
    }),
  ];
  const recordingStore = memoryRecordingStore(recordings);
  const firstJob = await createRecordingJob(recordings[0] as RecordingSummary);
  const secondJob = await createRecordingJob(recordings[1] as RecordingSummary);

  await failRecordingJob(firstJob.id, "capture_failed");
  await failRecordingJob(secondJob.id, "operator_cancelled");

  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });
  const response = await app.request("/api/v1/recording-jobs/bulk-retry", {
    body: JSON.stringify({ jobIds: [firstJob.id, secondJob.id, firstJob.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as {
    data: RecordingJob[];
    meta: { retriedCount: number };
  };
  const [event] = await auditStore.list({ action: "recording_jobs.bulk_retry.succeeded" });

  assert.equal(response.status, 201);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:control");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.bulk_retry");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "recording_job_collection",
    type: "recording_collection",
  });
  assert.equal(body.meta.retriedCount, 2);
  assert.equal(body.data.length, 2);
  assert(body.data.every((job) => job.status === "queued"));
  assert.equal((await recordingStore.find(recordings[0].id))?.status, "recording");
  assert.equal((await recordingStore.find(recordings[0].id))?.cached, false);
  assert.equal((await recordingStore.find(recordings[1].id))?.status, "recording");
  assert.equal(event?.permission, "recording:control");
  assert.equal(event?.target.id, "recording_job_collection");
  assert.deepEqual(event?.details.sourceJobIds, [firstJob.id, secondJob.id]);
  assert.equal(event?.details.requestedCount, 3);
  assert.equal(event?.details.retriedCount, 2);
});

test("recording job bulk stop route stops visible active jobs and audits collection", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recordings = [
    recordingSummary({ id: `rec_bulk_stop_a_${randomUUID()}`, status: "recording" }),
    recordingSummary({ id: `rec_bulk_stop_b_${randomUUID()}`, status: "recording" }),
  ];
  const recordingStore = memoryRecordingStore(recordings);
  const firstJob = await createRecordingJob(recordings[0] as RecordingSummary);
  const secondJob = await createRecordingJob(recordings[1] as RecordingSummary);
  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });
  const response = await app.request("/api/v1/recording-jobs/bulk-stop", {
    body: JSON.stringify({ jobIds: [firstJob.id, secondJob.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as {
    data: RecordingJob[];
    meta: { stoppedCount: number };
  };
  const [event] = await auditStore.list({ action: "recording_jobs.bulk_stop.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:control");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.bulk_stop");
  assert.equal(body.meta.stoppedCount, 2);
  assert(body.data.every((job) => job.status === "stop_requested"));
  assert.equal((await recordingStore.find(recordings[0].id))?.status, "completed");
  assert.equal((await recordingStore.find(recordings[1].id))?.status, "completed");
  assert.equal(event?.permission, "recording:control");
  assert.equal(event?.target.id, "recording_job_collection");
  assert.equal(event?.details.stoppedCount, 2);
});

test("recording job bulk retry rejects hidden jobs before mutating", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const visible = recordingSummary({ id: `rec_bulk_visible_${randomUUID()}`, status: "failed" });
  const hidden = recordingSummary({ id: `rec_bulk_hidden_${randomUUID()}`, status: "failed" });
  const recordingStore = memoryRecordingStore([visible, hidden]);
  const visibleJob = await createRecordingJob(visible);
  const hiddenJob = await createRecordingJob(hidden);

  await failRecordingJob(visibleJob.id, "capture_failed");
  await failRecordingJob(hiddenJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
    visibleRecordingIds: [visible.id],
  });
  const response = await app.request("/api/v1/recording-jobs/bulk-retry", {
    body: JSON.stringify({ jobIds: [visibleJob.id, hiddenJob.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recording_jobs.bulk_retry.failed" });

  assert.equal(response.status, 404);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "recording_job_not_visible");
  assert.deepEqual(event?.details.hiddenIds, [hiddenJob.id]);
});

test("recording job export search matches capture backend", () => {
  const filtered = filterRecordingJobsForExport(
    [
      job({
        command: { ...job().command, captureBackend: "pipewire" },
        id: "job_pipewire",
        status: "queued",
      }),
      job({
        command: { ...job().command, captureBackend: "alsa" },
        id: "job_alsa",
        status: "queued",
      }),
    ],
    { search: "pipewire" },
  );

  assert.deepEqual(
    filtered.map((recordingJob) => recordingJob.id),
    ["job_pipewire"],
  );
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

interface RecordingJobActionsResponse {
  data: {
    actions: Record<
      string,
      { enabled: boolean; href?: string; payload?: Record<string, unknown>; reason?: string }
    >;
    job: RecordingJob;
    recording?: RecordingSummary;
    retryConflict?: RecordingJob;
  };
}

function recordingApp({
  auditStore,
  permissionCalls,
  permissions,
  recordingStore,
  scopedRecordingSnapshots,
  visibleRecordingIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  permissionCalls: PermissionCall[];
  permissions?: Permission[];
  recordingStore: RecordingStore;
  scopedRecordingSnapshots?: RecordingSummary[];
  visibleRecordingIds?: string[];
}) {
  const app = new Hono<AppBindings>();
  const currentUser = user(permissions);

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => [],
    scopedRecordings: async () => {
      const recordings = scopedRecordingSnapshots ?? (await recordingStore.list());

      return visibleRecordingIds
        ? recordings.filter((recording) => visibleRecordingIds.includes(recording.id))
        : recordings;
    },
    settingsStore: memorySettingsStore(),
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    calls.push({
      action,
      permission,
      target: target ? await target(c) : undefined,
    });
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: "user_recording_job_export",
        name: "Recording Job Export User",
        roles: ["operator"],
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

function memoryNodeStore(): NodeStore {
  const node: RecorderNode = {
    agentVersion: "0.1.0",
    alias: "Room Recorder",
    hostname: "room-recorder",
    id: "node_1",
    interfaces: [],
    ipAddresses: ["10.1.2.3"],
    lastSeenAt: "2026-06-20T12:00:00.000Z",
    location: { room: "Room", site: "Main" },
    status: "online",
    tags: [],
  };

  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodeId === node.id ? node : undefined;
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return [node];
    },
    async rotateCredential() {
      throw new Error("not implemented");
    },
    async update() {
      throw new Error("not implemented");
    },
    async updateInterface() {
      throw new Error("not implemented");
    },
  };
}

function memoryMeterFrameStore(): MeterFrameStore {
  return {
    async history(): Promise<MeterFrame[]> {
      return [];
    },
    async latest() {
      return undefined;
    },
    async save(frame) {
      return {
        frame,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete() {
      return undefined;
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
      } else {
        recordings.unshift(recording);
      }
    },
  };
}

function memorySettingsStore(): SettingsStore {
  return {
    async findRecordingProfile(profileId) {
      return profileId === defaultVoiceRecordingProfile.id
        ? defaultVoiceRecordingProfile
        : undefined;
    },
    async listChannelMapAssignments() {
      return [];
    },
    async listRecordingProfiles(): Promise<RecordingProfile[]> {
      return [defaultVoiceRecordingProfile];
    },
  } as SettingsStore;
}

function user(permissions: Permission[] = ["recording:read"]): CurrentUser {
  return {
    email: "recording-job-export@example.com",
    groups: [],
    id: "user_recording_job_export",
    name: "Recording Job Export User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function job(input: Partial<RecordingJob> = {}): RecordingJob {
  return {
    command: {
      captureChannels: 2,
      captureDevice: "hw:0,0",
      captureFormat: "S16_LE",
      captureSampleRate: 48000,
      durationSeconds: 3600,
      outputCodec: "wav",
      outputFileName: "recording.wav",
      type: "alsa_capture",
    },
    createdAt: "2026-06-20T12:00:00.000Z",
    id: "job_1",
    nodeId: "node_1",
    recordingId: "rec_1",
    status: "queued",
    ...input,
  };
}

function recordingSummary(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "tests",
    healthStatus: "unknown",
    id: "rec_1",
    name: "Retry Recording",
    nodeId: "node_1",
    recordedAt: "2026-06-20T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: ["voice"],
    ...input,
  };
}
