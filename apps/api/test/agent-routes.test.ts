import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AppBindings } from "../src/http-types.js";
import type { SettingsStore } from "../src/settings-store.js";
import {
  createAuditStore,
  createHealthEventStore,
  createRecordingJob,
  createRetentionPolicy,
  flacProfile,
  memoryMeterFrameStore,
  memoryNodeStore,
  memoryRecordingStore,
  node,
  recordAuditEvent,
  recording,
  registerAgentRoutes,
} from "./agent-routes-harness.js";

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
