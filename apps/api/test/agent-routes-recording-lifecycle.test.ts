import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type { RecordingJob, RecordingSummary } from "@rakkr/shared";
import type { AppBindings } from "../src/http-types.js";
import {
  auth,
  createAuditStore,
  createHealthEventStore,
  createUploadPolicy,
  memoryMeterFrameStore,
  memoryNodeStore,
  memoryRecordingStore,
  memorySettingsStore,
  node,
  recordAuditEvent,
  registerAgentRoutes,
  registerRecordingRoutes,
  requirePermission,
  user,
  wavFile,
} from "./agent-routes-harness.js";

test("ad hoc recording completes through agent cache attach and exposes cached media", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const lifecycleNode = {
    ...node(),
    alias: "Lifecycle Recorder",
    id: `node_lifecycle_${randomUUID()}`,
  };
  const nodeStore = memoryNodeStore([lifecycleNode]);
  const recordingStore = memoryRecordingStore();
  const policy = await createUploadPolicy({
    enabled: true,
    id: `upload-policy-lifecycle-${randomUUID()}`,
    maxAttempts: 2,
    name: "Lifecycle Auto Stub",
    trigger: "on_recording_cached",
  });

  registerRecordingRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(),
    scopedNodes: () => nodeStore.list(),
    scopedRecordings: () => recordingStore.list(),
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
  });
  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
  });

  const started = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      name: "Lifecycle Recording",
      nodeId: lifecycleNode.id,
      tags: ["voice", "lifecycle"],
      uploadPolicyIds: [policy.id],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const startedBody = (await started.json()) as { data: RecordingSummary; job: RecordingJob };
  const next = await app.request(`/api/v1/nodes/${lifecycleNode.id}/recording-jobs/next`, {
    headers: { authorization: "Bearer node-token" },
  });
  const nextBody = (await next.json()) as { data: RecordingJob };
  const claimed = await app.request(`/api/v1/recording-jobs/${startedBody.job.id}/claim`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const heartbeat = await app.request(`/api/v1/recording-jobs/${startedBody.job.id}/heartbeat`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const wavBytes = wavFile([0, 12_000, -24_000, 6000]);
  const attached = await app.request(`/api/v1/recordings/${startedBody.data.id}/cache-file`, {
    body: wavBytes,
    headers: {
      authorization: "Bearer node-token",
      "content-type": "audio/wav",
      "x-rakkr-duration-seconds": "2",
      "x-rakkr-file-name": "lifecycle.wav",
      "x-rakkr-recording-job-id": startedBody.job.id,
    },
    method: "PUT",
  });
  const attachedBody = (await attached.json()) as {
    data: {
      recording: RecordingSummary;
      uploadQueueItem?: { recordingId: string; uploadPolicyId?: string };
    };
  };
  const completedJob = await app.request(`/api/v1/recording-jobs/${startedBody.job.id}`, {
    headers: { authorization: "Bearer node-token" },
  });
  const completedJobBody = (await completedJob.json()) as { data: RecordingJob };
  const playback = await app.request(`/api/v1/recordings/${startedBody.data.id}/playback`, {
    method: "POST",
  });
  const download = await app.request(`/api/v1/recordings/${startedBody.data.id}/download`, {
    method: "POST",
  });
  const stream = await app.request(`/api/v1/recordings/${startedBody.data.id}/stream`);
  const file = await app.request(`/api/v1/recordings/${startedBody.data.id}/file`);
  const cached = await recordingStore.find(startedBody.data.id);
  const [cacheAudit] = await auditStore.list({ action: "recordings.cache_file.attach.succeeded" });
  const [autoQueueAudit] = await auditStore.list({
    action: "recordings.upload_queue.auto_enqueue.succeeded",
  });

  assert.equal(started.status, 202);
  assert.equal(next.status, 200);
  assert.equal(nextBody.data.id, startedBody.job.id);
  assert.equal(claimed.status, 200);
  assert.equal(heartbeat.status, 200);
  assert.equal(attached.status, 201);
  assert.equal(attachedBody.data.recording.cached, true);
  assert.equal(attachedBody.data.recording.status, "cached");
  assert.equal(attachedBody.data.recording.healthStatus, "healthy");
  assert.equal(attachedBody.data.recording.cachePath, `ad-hoc/${startedBody.data.id}.wav`);
  assert.equal(attachedBody.data.recording.durationSeconds, 2);
  assert.equal(attachedBody.data.recording.waveformPreview?.peaks.length, 4);
  assert.equal(attachedBody.data.uploadQueueItem?.recordingId, startedBody.data.id);
  assert.equal(attachedBody.data.uploadQueueItem?.uploadPolicyId, policy.id);
  assert.equal(completedJob.status, 200);
  assert.equal(completedJobBody.data.status, "completed");
  assert.equal(cached?.status, "cached");
  assert.equal(cached?.healthStatus, "healthy");
  assert.equal(playback.status, 202);
  assert.equal(download.status, 202);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "audio/wav");
  assert.equal((await stream.arrayBuffer()).byteLength, wavBytes.byteLength);
  assert.equal(file.status, 200);
  assert.equal(
    file.headers.get("content-disposition"),
    'attachment; filename="Lifecycle Recording.wav"',
  );
  assert.equal(cacheAudit?.details.jobStatus, "completed");
  assert.equal(autoQueueAudit?.details.uploadPolicyId, policy.id);
});

test("claim-next lets one node claim multiple queued recordings independently", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const lifecycleNode = {
    ...node(),
    alias: "Concurrent Lifecycle Recorder",
    id: `node_concurrent_lifecycle_${randomUUID()}`,
    interfaces: [
      {
        alias: "Concurrent X32",
        backend: "alsa" as const,
        channelCount: 4,
        channels: [
          { alias: "Ch 1", index: 1 },
          { alias: "Ch 2", index: 2 },
          { alias: "Ch 3", index: 3 },
          { alias: "Ch 4", index: 4 },
        ],
        id: "iface_concurrent_x32",
        sampleRates: [48_000],
        systemName: "Concurrent X32",
        systemRef: "hw:CARD=X32,DEV=0",
      },
    ],
    recordingCapacity: { maxConcurrentRecordings: 2 },
  };
  const nodeStore = memoryNodeStore([lifecycleNode]);
  const recordingStore = memoryRecordingStore();

  registerRecordingRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(),
    scopedNodes: () => nodeStore.list(),
    scopedRecordings: () => recordingStore.list(),
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
  });
  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
  });

  const firstStarted = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureChannelSelection: [1, 2],
      captureInterfaceId: "iface_concurrent_x32",
      channelMode: "stereo",
      name: "Concurrent Recording A",
      nodeId: lifecycleNode.id,
      tags: ["voice", "concurrent"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const secondStarted = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureChannelSelection: [3, 4],
      captureInterfaceId: "iface_concurrent_x32",
      channelMode: "stereo",
      name: "Concurrent Recording B",
      nodeId: lifecycleNode.id,
      tags: ["voice", "concurrent"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const firstStartedBody = (await firstStarted.json()) as {
    data: RecordingSummary;
    job: RecordingJob;
  };
  const secondStartedBody = (await secondStarted.json()) as {
    data: RecordingSummary;
    job: RecordingJob;
  };
  const firstClaim = await app.request(
    `/api/v1/nodes/${lifecycleNode.id}/recording-jobs/claim-next`,
    {
      headers: { authorization: "Bearer node-token" },
      method: "POST",
    },
  );
  const secondClaim = await app.request(
    `/api/v1/nodes/${lifecycleNode.id}/recording-jobs/claim-next`,
    {
      headers: { authorization: "Bearer node-token" },
      method: "POST",
    },
  );
  const emptyClaim = await app.request(
    `/api/v1/nodes/${lifecycleNode.id}/recording-jobs/claim-next`,
    {
      headers: { authorization: "Bearer node-token" },
      method: "POST",
    },
  );
  const firstClaimBody = (await firstClaim.json()) as { data: RecordingJob };
  const secondClaimBody = (await secondClaim.json()) as { data: RecordingJob };
  const claimedJobIds = new Set([firstClaimBody.data.id, secondClaimBody.data.id]);
  const expectedJobIds = new Set([firstStartedBody.job.id, secondStartedBody.job.id]);
  const firstRecording = await recordingStore.find(firstStartedBody.data.id);
  const secondRecording = await recordingStore.find(secondStartedBody.data.id);
  const claimAudits = (
    await auditStore.list({
      action: "recording_jobs.claim_next.succeeded",
    })
  ).filter((event) => event.target.type === "recording_job");
  assert.equal(firstStarted.status, 202);
  assert.equal(secondStarted.status, 202);
  assert.equal(firstClaim.status, 200);
  assert.equal(secondClaim.status, 200);
  assert.equal(emptyClaim.status, 204);
  assert.deepEqual(claimedJobIds, expectedJobIds);
  assert.equal(firstClaimBody.data.status, "running");
  assert.equal(secondClaimBody.data.status, "running");
  assert.equal(firstRecording?.status, "recording");
  assert.equal(secondRecording?.status, "recording");
  assert.equal(claimAudits.length, 2);
});
test("controller stop request survives agent cancellation as completed recording", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const lifecycleNode = {
    ...node(),
    alias: "Stop Lifecycle Recorder",
    id: `node_stop_lifecycle_${randomUUID()}`,
  };
  const nodeStore = memoryNodeStore([lifecycleNode]);
  const recordingStore = memoryRecordingStore();

  registerRecordingRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(),
    scopedNodes: () => nodeStore.list(),
    scopedRecordings: () => recordingStore.list(),
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
  });
  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
  });

  const started = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      name: "Stop Lifecycle Recording",
      nodeId: lifecycleNode.id,
      tags: ["voice", "stop-lifecycle"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const startedBody = (await started.json()) as { data: RecordingSummary; job: RecordingJob };
  const claimed = await app.request(`/api/v1/recording-jobs/${startedBody.job.id}/claim`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const stopped = await app.request(`/api/v1/recordings/${startedBody.data.id}/stop`, {
    method: "POST",
  });
  const stoppedBody = (await stopped.json()) as { data: RecordingSummary };
  const cancelled = await app.request(`/api/v1/recording-jobs/${startedBody.job.id}/cancelled`, {
    headers: {
      authorization: "Bearer node-token",
      "x-rakkr-reason": "controller_stop_requested",
    },
    method: "POST",
  });
  const cancelledBody = (await cancelled.json()) as { data: RecordingJob };
  const updated = await recordingStore.find(startedBody.data.id);
  const healthEvents = await healthEventStore.list({ recordingId: startedBody.data.id });
  const [stopAudit] = await auditStore.list({ action: "recordings.stop.succeeded" });
  const [cancelAudit] = await auditStore.list({
    action: "recording_jobs.cancelled.succeeded",
  });

  assert.equal(started.status, 202);
  assert.equal(claimed.status, 200);
  assert.equal(stopped.status, 200);
  assert.equal(stoppedBody.data.status, "completed");
  assert.equal(stopAudit?.details.jobStatus, "stop_requested");
  assert.equal(cancelled.status, 200);
  assert.equal(cancelledBody.data.status, "cancelled");
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.healthStatus, "healthy");
  assert.equal(healthEvents.length, 0);
  assert.equal(cancelAudit?.details.reason, "controller_stop_requested");
  assert.equal(cancelAudit?.details.recordingStatus, "completed");
});
