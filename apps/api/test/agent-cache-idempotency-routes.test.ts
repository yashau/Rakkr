import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, MeterFrame, RecorderNode, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput, NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const cacheRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-cache-idempotency-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(cacheRoot, "jobs.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(cacheRoot, "cache");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(cacheRoot, "retention-policies.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(cacheRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(cacheRoot, "upload-queue.json");
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(cacheRoot, "chunks.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { claimRecordingJob, createRecordingJob, failRecordingJob, recordingJob } = await import(
  "../src/recording-jobs.js"
);
const { listRecordingChunksForRecording } = await import("../src/recording-chunks.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { listUploadQueueItems, succeedUploadQueueItem } = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(cacheRoot, { force: true, recursive: true });
});

test("duplicate cache attach after upload success reuses existing upload queue item", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const recorderNode = node();
  const recordingStore = memoryRecordingStore([recording(recorderNode.id)]);
  const [sourceRecording] = await recordingStore.list();
  const policy = await createUploadPolicy({
    enabled: true,
    id: `upload-policy-idempotent-cache-${randomUUID()}`,
    maxAttempts: 2,
    name: "Idempotent Cache Auto Stub",
    trigger: "on_recording_cached",
  });

  sourceRecording.uploadPolicyIds = [policy.id];
  const job = await createRecordingJob(sourceRecording);
  await claimRecordingJob(job.id, recorderNode.id);

  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(recorderNode),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const wavBytes = wavFile([0, 12_000, -24_000, 6000]);
  const attachHeaders = {
    authorization: "Bearer node-token",
    "content-type": "audio/wav",
    "x-rakkr-duration-seconds": "2",
    "x-rakkr-file-name": "idempotent-cache.wav",
    "x-rakkr-recording-job-id": job.id,
  };
  const firstAttach = await app.request(`/api/v1/recordings/${sourceRecording.id}/cache-file`, {
    body: wavBytes,
    headers: attachHeaders,
    method: "PUT",
  });
  const firstBody = (await firstAttach.json()) as {
    data: { uploadQueueItem?: { id: string; status: string } };
  };

  await succeedUploadQueueItem(firstBody.data.uploadQueueItem?.id ?? "");

  const duplicateAttach = await app.request(`/api/v1/recordings/${sourceRecording.id}/cache-file`, {
    body: wavBytes,
    headers: attachHeaders,
    method: "PUT",
  });
  const duplicateBody = (await duplicateAttach.json()) as {
    data: { uploadQueueItem?: { id: string; status: string } };
  };
  const uploadItems = (await listUploadQueueItems()).filter(
    (item) => item.recordingId === sourceRecording.id,
  );

  assert.equal(firstAttach.status, 201);
  assert.equal(duplicateAttach.status, 201);
  assert.equal(duplicateBody.data.uploadQueueItem?.id, firstBody.data.uploadQueueItem?.id);
  assert.equal(duplicateBody.data.uploadQueueItem?.status, "succeeded");
  assert.equal(uploadItems.length, 1);
});

test("chunk upload without an owning job is rejected instead of persisting an empty jobId", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const recorderNode = node();
  const recordingStore = memoryRecordingStore([recording(recorderNode.id)]);
  const [joblessRecording] = await recordingStore.list();
  // Deliberately create NO recording job for this recording.

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(recorderNode),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(
    `/api/v1/recordings/${joblessRecording.id}/cache-file?chunk=0`,
    {
      body: wavFile([0, 1000, -1000, 500]),
      headers: {
        authorization: "Bearer node-token",
        "content-type": "audio/wav",
        "x-rakkr-duration-seconds": "2",
        "x-rakkr-file-name": "orphan-chunk.wav",
        // No x-rakkr-recording-job-id, and the recording has no job row.
      },
      method: "PUT",
    },
  );
  const chunks = await listRecordingChunksForRecording(joblessRecording.id);

  // Pre-fix this persisted a chunk row with jobId:"" that then failed the read
  // schema (jobId.min(1)) and broke the chunk store on the next load.
  assert.equal(response.status, 409);
  assert.equal(chunks.length, 0);
});

test("G47: cache upload for a terminal-failed job is rejected (no job/recording resurrection)", async () => {
  const app = new Hono<AppBindings>();
  const recorderNode = node();
  const recordingStore = memoryRecordingStore([recording(recorderNode.id)]);
  const [sourceRecording] = await recordingStore.list();
  const job = await createRecordingJob(sourceRecording);
  await claimRecordingJob(job.id, recorderNode.id);
  // The controller reaps the job (lease expiry / explicit fail). The recording
  // stays `recording` here so this exercises the JOB terminal guard, not the
  // recording-status guard.
  await failRecordingJob(job.id, "lease_expired");

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(recorderNode),
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/recordings/${sourceRecording.id}/cache-file`, {
    body: wavFile([0, 1000, -1000, 500]),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "audio/wav",
      "x-rakkr-duration-seconds": "2",
      "x-rakkr-file-name": "late-upload.wav",
      "x-rakkr-recording-job-id": job.id,
    },
    method: "PUT",
  });
  const reloadedJob = await recordingJob(job.id);
  const uploadItems = (await listUploadQueueItems()).filter(
    (item) => item.recordingId === sourceRecording.id,
  );

  // Pre-fix this returned 201, flipped the job failed -> completed, the recording
  // -> cached, and re-fanned the upload queue.
  assert.equal(response.status, 409);
  assert.equal(reloadedJob?.status, "failed");
  assert.equal((await recordingStore.find(sourceRecording.id))?.status, "recording");
  assert.equal(uploadItems.length, 0);
});

test("G47: cache upload for a terminally failed recording is rejected", async () => {
  const app = new Hono<AppBindings>();
  const recorderNode = node();
  const failedRecording = { ...recording(recorderNode.id), status: "failed" as const };
  const recordingStore = memoryRecordingStore([failedRecording]);

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(recorderNode),
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/recordings/${failedRecording.id}/cache-file`, {
    body: wavFile([0, 1000, -1000, 500]),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "audio/wav",
      "x-rakkr-duration-seconds": "2",
      "x-rakkr-file-name": "late-upload.wav",
    },
    method: "PUT",
  });

  assert.equal(response.status, 409);
  // The recording is not resurrected to cached.
  assert.equal((await recordingStore.find(failedRecording.id))?.status, "failed");
});

function memoryNodeStore(recorderNode: RecorderNode): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? {
            credentialId: "cred_agent_cache_idempotency",
            nodeId: recorderNode.id,
            tokenPrefix: "node-token",
          }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodeId === recorderNode.id ? recorderNode : undefined;
    },
    async heartbeat(nodeId: string, input: NodeHeartbeatInput) {
      if (nodeId !== recorderNode.id) {
        return undefined;
      }

      return {
        ...recorderNode,
        agentVersion: input.agentVersion,
        hostname: input.hostname,
        ipAddresses: input.ipAddresses,
        lastSeenAt: new Date().toISOString(),
        runtime: input.runtime,
        status: input.status,
      };
    },
    async list() {
      return [recorderNode];
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

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);

      return index >= 0 ? recordings.splice(index, 1)[0] : undefined;
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
      } else {
        recordings.unshift(recording);
      }
    },
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "test",
        name: "Test",
        roles: [],
        type: "system",
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

function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Cache Idempotency Recorder",
    hostname: "cache-idempotency-recorder",
    id: `node_cache_idempotency_${randomUUID()}`,
    interfaces: [],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-25T12:00:00.000Z",
    location: { room: "Test", site: "Lab" },
    status: "online",
    tags: ["test"],
  };
}

function recording(nodeId: string): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "tests",
    healthStatus: "unknown",
    id: `rec_cache_idempotency_${randomUUID()}`,
    name: "Cache Idempotency Recording",
    nodeId,
    recordedAt: "2026-06-25T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: ["voice"],
  };
}

function wavFile(samples: number[]) {
  const data = Buffer.alloc(samples.length * 2);

  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}
