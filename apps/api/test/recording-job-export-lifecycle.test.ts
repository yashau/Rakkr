import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import type { RecordingJob, RecordingSummary } from "@rakkr/shared";
import {
  createAuditStore,
  createRecordingJob,
  failRecordingJob,
  memoryRecordingStore,
  recordingApp,
  recordingSummary,
  routeRoot,
  type PermissionCall,
} from "./recording-job-export-harness.js";

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
