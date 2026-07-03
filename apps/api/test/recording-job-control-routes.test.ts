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
  RecordingJob,
  RecordingSummary,
} from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-job-control-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(routeRoot, "retention-policies.json");
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(routeRoot, "chunks.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(routeRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createRecordingJob, failRecordingJob } = await import("../src/recording-jobs.js");
const { registerRecordingJobRoutes } = await import("../src/recording-job-routes.js");
const { enqueueRecordingUpload, listUploadQueueItems } = await import("../src/upload-queue.js");
const { listRecordingChunksForRecording, recordingChunkId, upsertRecordingChunk } =
  await import("../src/recording-chunks.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording job retry route uses scoped recording context for state reset", async () => {
  const auditStore = createAuditStore("");
  const scopedRecording = recording({
    cachePath: path.join(routeRoot, "scoped-stale.wav"),
    cached: true,
    checksum: "scoped-stale-checksum",
    durationSeconds: 44,
    healthStatus: "critical",
    id: `rec_retry_scoped_${randomUUID()}`,
    name: "Scoped Retry Context",
    status: "failed",
  });
  const rawRecording = recording({
    id: scopedRecording.id,
    name: "Raw Retry Context",
    status: "completed",
  });
  const recordingStore = memoryRecordingStore([rawRecording]);
  const sourceJob = await createRecordingJob(scopedRecording);

  await failRecordingJob(sourceJob.id, "capture_failed");

  const app = recordingJobApp({
    auditStore,
    recordingStore,
    scopedRecordingSnapshots: [scopedRecording],
  });
  const response = await app.request(`/api/v1/recording-jobs/${sourceJob.id}/retry`, {
    method: "POST",
  });
  const body = (await response.json()) as { data: RecordingJob };
  const updatedRecording = await recordingStore.find(scopedRecording.id);
  const [event] = await auditStore.list({ action: "recording_jobs.retry.succeeded" });

  assert.equal(response.status, 201);
  assert.equal(body.data.recordingId, scopedRecording.id);
  assert.equal(updatedRecording?.name, "Scoped Retry Context");
  assert.equal(updatedRecording?.status, "recording");
  assert.equal(updatedRecording?.cached, false);
  assert.equal(updatedRecording?.durationSeconds, 0);
  assert.equal(event?.before?.recordingStatus, "failed");
  assert.equal(event?.target.name, "Scoped Retry Context");
});

test("G56: retry clears supplementary renditions and sweeps stale chunk rows", async () => {
  const auditStore = createAuditStore("");
  const chunkedRecording = recording({
    cached: true,
    enhancedCachePath: "scheduled/rec_retry_chunked/part0001.enhanced.mp3",
    id: `rec_retry_chunked_${randomUUID()}`,
    name: "Chunked Retry",
    rawCachePath: "scheduled/rec_retry_chunked/part0001.raw.wav",
    status: "partial",
  });
  const recordingStore = memoryRecordingStore([chunkedRecording]);
  const sourceJob = await createRecordingJob(chunkedRecording);

  await failRecordingJob(sourceJob.id, "capture_failed");
  await upsertRecordingChunk({
    cachePath: "scheduled/rec_retry_chunked/part0001.mp3",
    createdAt: "2026-06-18T12:00:00.000Z",
    durationSeconds: 60,
    id: recordingChunkId(chunkedRecording.id, 1),
    index: 1,
    jobId: sourceJob.id,
    offsetSeconds: 0,
    recordingId: chunkedRecording.id,
    status: "uploaded",
    total: 2,
  });

  const app = recordingJobApp({
    auditStore,
    recordingStore,
    scopedRecordingSnapshots: [chunkedRecording],
  });
  const response = await app.request(`/api/v1/recording-jobs/${sourceJob.id}/retry`, {
    method: "POST",
  });
  const updated = await recordingStore.find(chunkedRecording.id);
  const remainingChunks = await listRecordingChunksForRecording(chunkedRecording.id);

  assert.equal(response.status, 201);
  // Pre-fix rawCachePath/enhancedCachePath survived (the UI served the failed
  // attempt's audio) and the stale chunk rows persisted (contaminating the
  // retry's chunked finalization → spurious `partial`).
  assert.equal(updated?.rawCachePath, undefined);
  assert.equal(updated?.enhancedCachePath, undefined);
  assert.equal(remainingChunks.length, 0);
});

test("retry sweeps the prior attempt's orphaned upload-queue items", async () => {
  const auditStore = createAuditStore("");
  const rec = recording({
    id: `rec_retry_upload_${randomUUID()}`,
    name: "Upload Retry",
    status: "partial",
  });
  const recordingStore = memoryRecordingStore([rec]);
  const sourceJob = await createRecordingJob(rec);

  await failRecordingJob(sourceJob.id, "capture_failed");
  await enqueueRecordingUpload(rec);

  // Precondition: the failed attempt left an upload-queue item for the recording.
  assert.equal(
    (await listUploadQueueItems()).filter((item) => item.recordingId === rec.id).length,
    1,
  );

  const app = recordingJobApp({
    auditStore,
    recordingStore,
    scopedRecordingSnapshots: [rec],
  });
  const response = await app.request(`/api/v1/recording-jobs/${sourceJob.id}/retry`, {
    method: "POST",
  });

  assert.equal(response.status, 201);
  // The retry sweeps the orphaned item so it cannot pin retention (a stale `failed`
  // item) or make the upload runner re-attempt a purged file (cache_path_missing).
  assert.equal(
    (await listUploadQueueItems()).filter((item) => item.recordingId === rec.id).length,
    0,
  );
});

test("recording job bulk stop route uses scoped recording context for updates", async () => {
  const auditStore = createAuditStore("");
  const scopedRecording = recording({
    durationSeconds: 7,
    id: `rec_bulk_stop_scoped_${randomUUID()}`,
    name: "Scoped Stop Context",
    status: "recording",
  });
  const rawRecording = recording({
    durationSeconds: 0,
    id: scopedRecording.id,
    name: "Raw Stop Context",
    // Stoppable status so the stop CAS transitions; the scoped/raw NAME divergence
    // still verifies the route persists the scoped context, not the raw record.
    status: "recording",
  });
  const recordingStore = memoryRecordingStore([rawRecording]);
  const job = await createRecordingJob(scopedRecording);
  const app = recordingJobApp({
    auditStore,
    recordingStore,
    scopedRecordingSnapshots: [scopedRecording],
  });

  const response = await app.request("/api/v1/recording-jobs/bulk-stop", {
    body: JSON.stringify({ jobIds: [job.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const updatedRecording = await recordingStore.find(scopedRecording.id);
  const [event] = await auditStore.list({ action: "recording_jobs.bulk_stop.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(updatedRecording?.name, "Scoped Stop Context");
  assert.equal(updatedRecording?.status, "completed");
  assert.equal(updatedRecording?.durationSeconds, 7);
  assert.deepEqual(event?.before?.jobs, [
    {
      jobId: job.id,
      recordingId: scopedRecording.id,
      recordingStatus: "recording",
      status: "queued",
    },
  ]);
});

test("G65: bulk stop does not downgrade a recording a concurrent upload secured", async () => {
  const auditStore = createAuditStore("");
  const scoped = recording({
    id: `rec_bulk_stop_secured_${randomUUID()}`,
    name: "Secured Recording",
    status: "recording",
  });
  // Between the scoped snapshot and the stop, a cache upload secured the recording.
  const secured = recording({
    cached: true,
    id: scoped.id,
    name: "Secured Recording",
    status: "cached",
  });
  const recordingStore = memoryRecordingStore([secured]);
  const job = await createRecordingJob(scoped);
  const app = recordingJobApp({
    auditStore,
    recordingStore,
    scopedRecordingSnapshots: [scoped],
  });

  const response = await app.request("/api/v1/recording-jobs/bulk-stop", {
    body: JSON.stringify({ jobIds: [job.id] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const updated = await recordingStore.find(scoped.id);

  // Pre-fix the blind write forced "completed" over the secured "cached"; the CAS
  // now only transitions from a still-active status.
  assert.equal(response.status, 200);
  assert.equal(updated?.status, "cached");
});

function recordingJobApp({
  auditStore,
  recordingStore,
  scopedRecordingSnapshots,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  recordingStore: RecordingStore;
  scopedRecordingSnapshots: RecordingSummary[];
}) {
  const app = new Hono<AppBindings>();
  const currentUser = user();

  registerRecordingJobRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: allowPermission,
    scopedRecordings: async () => scopedRecordingSnapshots,
  });

  return app;
}

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: "user_recording_job_control",
        name: "Recording Job Control User",
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
    async transition(recording, allowedFrom) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);
      const current = recordings[index];

      if (!current || !allowedFrom.includes(current.status)) {
        return undefined;
      }

      recordings[index] = recording;

      return recording;
    },
  };
}

function user(permissions: Permission[] = ["recording:control", "recording:read"]): CurrentUser {
  return {
    email: "recording-job-control@example.com",
    groups: [],
    id: "user_recording_job_control",
    name: "Recording Job Control User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "control",
    healthStatus: "unknown",
    id: "rec_control",
    name: "Control Recording",
    nodeId: "node_control",
    recordedAt: "2026-06-22T09:35:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: [],
    ...input,
  };
}
