import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { RecordingJob, RecordingSummary } from "@rakkr/shared";
import type { AppBindings } from "../src/http-types.js";
import {
  createAuditStore,
  createHealthEventStore,
  createRecordingJob,
  failRecordingJob,
  memoryMeterFrameStore,
  memoryNodeStore,
  memoryRecordingStore,
  memorySettingsStore,
  recordAuditEvent,
  recordingApp,
  recordingSummary,
  registerAgentRoutes,
  registerRecordingRoutes,
  requirePermission,
  user,
  type PermissionCall,
  type RecordingJobActionsResponse,
} from "./recording-job-export-harness.js";

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
  const [successEvent] = await auditStore.list({ action: "recording_jobs.read.succeeded" });
  const [failedEvent] = await auditStore.list({ action: "recording_jobs.read.failed" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.read");
  assert.deepEqual(
    body.data.map((recordingJob) => recordingJob.id),
    [jackJob.id],
  );
  assert.equal(invalidResponse.status, 400);
  assert.equal(successEvent?.target.id, "recording_job_collection");
  assert.equal(successEvent?.details.returnedCount, 1);
  assert.equal(successEvent?.details.filters.status, "queued");
  assert.equal(failedEvent?.target.id, "recording_job_collection");
  assert.equal(failedEvent?.reason, "invalid_filters");
  assert.equal(failedEvent?.details.issueCount, 1);
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
  const [successEvent] = await auditStore.list({
    action: "recording_jobs.detail.read.succeeded",
  });
  const failedEvents = await auditStore.list({ action: "recording_jobs.detail.read.failed" });

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
  assert.equal(successEvent?.target.id, visibleJob.id);
  assert.equal(successEvent?.correlationIds.recordingId, visible.id);
  assert.equal(successEvent?.details.recordingId, visible.id);
  assert.equal(successEvent?.details.status, visibleJob.status);
  assert.deepEqual(failedEvents.map((event) => [event.target.id, event.reason]).sort(), [
    [hiddenJob.id, "recording_job_not_found"],
    ["job_missing_detail", "recording_job_not_found"],
  ]);
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
