import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";
import {
  createAuditStore,
  createRecordingJob,
  filterRecordingJobsForExport,
  job,
  memoryRecordingStore,
  recordingApp,
  recordingJobsCsv,
  recordingSummary,
  type PermissionCall,
} from "./recording-job-export-harness.js";

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
