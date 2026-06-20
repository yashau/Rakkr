import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type {
  AuditEvent,
  CurrentUser,
  MeterFrame,
  Permission,
  RecorderNode,
  RecordingJob,
  RecordingProfile,
  RecordingSummary,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput, NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const agentRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(agentRoot, "jobs.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(agentRoot, "cache");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(agentRoot, "retention-policies.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(agentRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(agentRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createRecordingJob } = await import("../src/recording-jobs.js");
const { createRetentionPolicy } = await import("../src/retention-policies.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");

test.after(async () => {
  await rm(agentRoot, { force: true, recursive: true });
});

test("agent failed job marks recording metadata failed", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const recordingStore = memoryRecordingStore([recording()]);
  const job = await createRecordingJob((await recordingStore.list())[0]!);

  assert.equal(job.command.outputBitrateKbps, 128);
  assert.equal(job.command.outputCodec, "mp3");
  assert.equal(job.command.outputFileName, "rec_agent_failure.mp3");
  assert.equal(job.command.outputVbr, true);

  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/recording-jobs/${job.id}/failed`, {
    headers: {
      authorization: "Bearer node-token",
      "x-rakkr-reason": "capture_output_stalled",
    },
    method: "POST",
  });
  const updated = await recordingStore.find("rec_agent_failure");
  const [healthEvent] = await healthEventStore.list({ recordingId: "rec_agent_failure" });
  const [event] = await auditStore.list({ action: "recording_jobs.failed.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(updated?.status, "failed");
  assert.equal(updated?.healthStatus, "critical");
  assert.equal(healthEvent?.severity, "critical");
  assert.equal(healthEvent?.type, "controller.recording.job_failed");
  assert.equal(healthEvent?.details.reason, "capture_output_stalled");
  assert.equal(event?.details.healthEventId, healthEvent?.id);
  assert.equal(event?.details.recordingStatus, "failed");
  assert.equal(event?.details.reason, "capture_output_stalled");
});

test("agent unexpected cancellation marks recording health warning", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const recordingStore = memoryRecordingStore([
    {
      ...recording(),
      id: "rec_agent_cancelled",
      name: "Agent Cancelled Test",
    },
  ]);
  const job = await createRecordingJob((await recordingStore.list())[0]!);

  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/recording-jobs/${job.id}/cancelled`, {
    headers: {
      authorization: "Bearer node-token",
      "x-rakkr-reason": "capture_process_exited",
    },
    method: "POST",
  });
  const updated = await recordingStore.find("rec_agent_cancelled");
  const [healthEvent] = await healthEventStore.list({ recordingId: "rec_agent_cancelled" });
  const [event] = await auditStore.list({ action: "recording_jobs.cancelled.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.healthStatus, "warning");
  assert.equal(healthEvent?.severity, "warning");
  assert.equal(healthEvent?.type, "controller.recording.job_cancelled");
  assert.equal(healthEvent?.details.reason, "capture_process_exited");
  assert.equal(event?.details.healthEventId, healthEvent?.id);
  assert.equal(event?.details.recordingStatus, "completed");
});

test("agent heartbeat updates node runtime details and audits inventory changes", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const nodeStore = memoryNodeStore();

  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/heartbeat`, {
    body: JSON.stringify({
      agentVersion: "0.2.0",
      hostname: "agent-route-node-live",
      ipAddresses: ["10.9.0.8"],
      runtime: {
        architecture: "x86_64",
        audioBackends: ["alsa"],
        kernelRelease: "6.1.0-test",
        osName: "Debian GNU/Linux 12",
        uptimeSeconds: 12345,
      },
      status: "online",
    }),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const body = (await response.json()) as { data: RecorderNode };
  const [event] = await auditStore.list({ action: "nodes.heartbeat.succeeded" });

  assert.equal(response.status, 202);
  assert.equal(body.data.agentVersion, "0.2.0");
  assert.equal(body.data.hostname, "agent-route-node-live");
  assert.deepEqual(body.data.ipAddresses, ["10.9.0.8"]);
  assert.equal(body.data.runtime?.kernelRelease, "6.1.0-test");
  assert.equal(body.data.runtime?.uptimeSeconds, 12345);
  assert.equal(event?.actor.type, "node");
  assert.equal(event?.permission, "node:control");
  assert.equal(event?.after?.hostname, "agent-route-node-live");
});

test("agent config read returns node recording capacity and recorder-cache policies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const policy = await createRetentionPolicy({
    action: "delete_cache",
    deleteOnlyAfterUploaded: true,
    enabled: true,
    id: `retention-node-config-${randomUUID()}`,
    maxAgeDays: 7,
    maxBytes: 2048,
    name: "Node Config Recorder Cache Sweep",
    scope: "recorder_cache",
  });
  const nodeStore = memoryNodeStore([
    {
      ...node(),
      audioDefaults: {
        captureArgsTemplate: "--capture {device} --rate {sample_rate} --output {output}",
        captureBackend: "jack",
        captureChannels: 4,
        captureCommand: "custom-capture",
        captureDevice: "system:capture_1",
        captureFormat: "S24_LE",
        captureSampleRate: 96_000,
        meterArgsTemplate: "--meter {device} --stdout",
      },
      recordingCapacity: { maxConcurrentRecordings: 8 },
    },
  ]);

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/config`, {
    headers: { authorization: "Bearer node-token" },
  });
  const body = (await response.json()) as {
    data: {
      recorderCachePolicies: Array<{
        deleteAfterUpload: boolean;
        maxAgeDays: number | null;
        maxBytes: number | null;
        policyId: string;
      }>;
      audioDefaults: {
        captureBackend?: string;
        captureCommand?: string;
        captureDevice?: string;
        captureSampleRate?: number;
      };
      recordingCapacity: { maxConcurrentRecordings: number };
    };
  };
  const [event] = await auditStore.list({ action: "nodes.config.read.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.data.audioDefaults.captureBackend, "jack");
  assert.equal(body.data.audioDefaults.captureCommand, "custom-capture");
  assert.equal(body.data.audioDefaults.captureDevice, "system:capture_1");
  assert.equal(body.data.audioDefaults.captureSampleRate, 96_000);
  assert.equal(body.data.recordingCapacity.maxConcurrentRecordings, 8);
  assert.deepEqual(
    body.data.recorderCachePolicies.find((item) => item.policyId === policy.id),
    {
      deleteAfterUpload: false,
      maxAgeDays: 7,
      maxBytes: 2048,
      minFreeDiskPercent: null,
      policyId: policy.id,
    },
  );
  assert.equal(event?.permission, "node:control");
  assert.equal(event?.details.audioDefaultsConfigured, true);
  assert.equal(event?.details.recordingCapacity.maxConcurrentRecordings, 8);
  assert.ok(Number(event?.details.recorderCachePolicyCount) >= 1);
});

test("agent service routes audit missing node credentials with route permissions", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    settingsStore: {} as SettingsStore,
  });

  const requests = [
    {
      action: "nodes.config.read.failed",
      path: "/api/v1/nodes/node_agent_test/config",
      permission: "node:control",
    },
    {
      action: "nodes.channel_map_assignments.read.failed",
      path: "/api/v1/nodes/node_agent_test/channel-map-assignments",
      permission: "node:control",
    },
    {
      action: "nodes.heartbeat.failed",
      method: "POST",
      path: "/api/v1/nodes/node_agent_test/heartbeat",
      permission: "node:control",
    },
    {
      action: "nodes.meter_frame.ingest.failed",
      method: "POST",
      path: "/api/v1/nodes/node_agent_test/meter-frame",
      permission: "node:control",
    },
    {
      action: "nodes.health_events.sync.failed",
      method: "POST",
      path: "/api/v1/nodes/node_agent_test/health-events",
      permission: "health:acknowledge",
    },
    {
      action: "recording_jobs.next.failed",
      path: "/api/v1/nodes/node_agent_test/recording-jobs/next",
      permission: "recording:control",
    },
    {
      action: "recording_jobs.claim.failed",
      method: "POST",
      path: "/api/v1/recording-jobs/job_agent_missing_token/claim",
      permission: "recording:control",
    },
    {
      action: "recording_jobs.heartbeat.failed",
      method: "POST",
      path: "/api/v1/recording-jobs/job_agent_missing_token/heartbeat",
      permission: "recording:control",
    },
    {
      action: "recording_jobs.read_one.failed",
      path: "/api/v1/recording-jobs/job_agent_missing_token",
      permission: "recording:control",
    },
    {
      action: "recording_jobs.cancelled.failed",
      method: "POST",
      path: "/api/v1/recording-jobs/job_agent_missing_token/cancelled",
      permission: "recording:control",
    },
    {
      action: "recording_jobs.failed.failed",
      method: "POST",
      path: "/api/v1/recording-jobs/job_agent_missing_token/failed",
      permission: "recording:control",
    },
    {
      action: "recordings.cache_file.attach.failed",
      method: "PUT",
      path: "/api/v1/recordings/rec_agent_missing_token/cache-file",
      permission: "recording:control",
    },
  ];
  const responses = await Promise.all(
    requests.map((request) => app.request(request.path, { method: request.method ?? "GET" })),
  );
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    Array.from({ length: requests.length }, () => 401),
  );
  assert.deepEqual(
    Object.fromEntries(deniedEvents.map((event) => [event.action, event.permission]).sort()),
    Object.fromEntries(requests.map((request) => [request.action, request.permission]).sort()),
  );
  assert.ok(deniedEvents.every((event) => event.reason === "missing_node_token"));
});

test("recording job honors custom output profile", async () => {
  const job = await createRecordingJob(
    {
      ...recording(),
      id: "rec_custom_profile",
    },
    {
      profile: flacProfile(),
    },
  );

  assert.equal(job.command.outputBitrateKbps, 256);
  assert.equal(job.command.outputCodec, "flac");
  assert.equal(job.command.outputFileName, "rec_custom_profile.flac");
  assert.equal(job.command.outputVbr, false);
});

test("recording job carries recorder-cache retention policy", async () => {
  const policy = await createRetentionPolicy({
    action: "delete_cache",
    deleteOnlyAfterUploaded: true,
    enabled: true,
    id: `retention-recorder-cache-${randomUUID()}`,
    maxAgeDays: 2,
    name: "Delete Recorder Cache After Upload",
    scope: "recorder_cache",
  });
  const job = await createRecordingJob({
    ...recording(),
    id: "rec_recorder_cache_retention",
    retentionPolicyId: policy.id,
  });

  assert.deepEqual(job.command.recorderCacheRetention, {
    deleteAfterUpload: false,
    maxAgeDays: 2,
    maxBytes: null,
    minFreeDiskPercent: null,
    policyId: policy.id,
  });
});

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
    provider: "stub",
    target: "stub://lifecycle",
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
      uploadPolicyId: policy.id,
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
      name: "Concurrent Recording A",
      nodeId: lifecycleNode.id,
      tags: ["voice", "concurrent"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const secondStarted = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
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
  const claimAudits = await auditStore.list({
    action: "recording_jobs.claim_next.succeeded",
  });

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

function memoryNodeStore(nodes: RecorderNode[] = [node()]): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? {
            credentialId: "cred_agent_test",
            nodeId: nodes[0]?.id ?? "node_agent_test",
            tokenPrefix: "node-token",
          }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
    },
    async heartbeat(nodeId: string, input: NodeHeartbeatInput) {
      const index = nodes.findIndex((candidate) => candidate.id === nodeId);

      if (index < 0) {
        return undefined;
      }

      nodes[index] = {
        ...nodes[index],
        agentVersion: input.agentVersion,
        hostname: input.hostname,
        ipAddresses: input.ipAddresses,
        lastSeenAt: new Date().toISOString(),
        runtime: input.runtime,
        status: input.status,
      };

      return nodes[index];
    },
    async list() {
      return nodes;
    },
    async rotateCredential() {
      throw new Error("not implemented");
    },
    async updateInterface() {
      throw new Error("not implemented");
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

function requirePermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function memoryMeterFrameStore(): MeterFrameStore {
  const frames: MeterFrame[] = [];

  return {
    async history(nodeId, limit = frames.length) {
      return frames.filter((frame) => frame.nodeId === nodeId).slice(0, limit);
    },
    async latest() {
      return frames[0];
    },
    async save(frame) {
      frames.unshift(frame);

      return {
        frame,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "anonymous",
        name: "Anonymous",
        roles: [],
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

function memorySettingsStore(profiles: RecordingProfile[]): SettingsStore {
  return {
    async assignChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async createChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async findChannelMapTemplate() {
      return undefined;
    },
    async findRecordingProfile(profileId) {
      return profiles.find((profile) => profile.id === profileId);
    },
    async findWatchdogPolicy() {
      return undefined;
    },
    async listChannelMapAssignments() {
      return [];
    },
    async listChannelMapTemplates() {
      return [];
    },
    async listRecordingProfiles() {
      return profiles;
    },
    async listWatchdogPolicies() {
      return [];
    },
    async rollbackChannelMapAssignment() {
      return undefined;
    },
    async updateChannelMapTemplate() {
      return undefined;
    },
    async updateRecordingProfile() {
      return undefined;
    },
    async updateWatchdogPolicy() {
      return undefined;
    },
  };
}

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "agent-route@example.com",
    groups: [],
    id: "user_agent_route",
    name: "Agent Route User",
    permissions: [
      "recording:create",
      "recording:download",
      "recording:playback",
      "recording:read",
    ] satisfies Permission[],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Agent Route Node",
    hostname: "agent-route-node",
    id: "node_agent_test",
    interfaces: [],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Test Room",
      site: "Test Site",
    },
    status: "recording",
    tags: [],
  };
}

function recording(): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "unknown",
    id: "rec_agent_failure",
    name: "Agent Failure Test",
    nodeId: "node_agent_test",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "recording",
    tags: ["voice"],
  };
}

function flacProfile(): RecordingProfile {
  return {
    bitrateKbps: 256,
    channelMode: "stereo",
    codec: "flac",
    id: "voice-flac",
    name: "Voice FLAC",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: false,
  };
}

function wavFile(samples: number[]) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48_000, 24);
  buffer.writeUInt32LE(96_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));

  return buffer;
}
