import type { Context } from "hono";
import type {
  RecordingChunk,
  RecordingJob,
  RecordingSummary,
  UploadPolicy,
  UploadQueueItem,
} from "@rakkr/shared";

import { nodeActor, recordingFileSnapshot } from "./agent-route-helpers.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { HealthEventStore } from "./health-store.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { NodeCredentialAuth } from "./node-store.js";
import {
  applyStoredChunkRendition,
  type RecordingRendition,
  storeRecordingChunkFile,
  type StoredRecordingFile,
} from "./recording-cache.js";
import {
  findRecordingChunk,
  listRecordingChunksForRecording,
  recordingChunkId,
  setRecordingChunkTotal,
  upsertRecordingChunk,
} from "./recording-chunks.js";
import { completeRecordingJob } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import type { UploadDestinationStore } from "./upload-destinations.js";
import {
  uploadPoliciesForCachedRecording,
  uploadPoliciesForChunkedRecording,
  uploadQueueInputForPolicy,
} from "./upload-policies.js";
import { enqueueRecordingUpload } from "./upload-queue.js";

interface RecordingFileFailureInput {
  actor: NodeCredentialAuth;
  createHealthEvent?: boolean;
  jobId?: string;
  reason: string;
  recordingId: string;
  severity?: "critical" | "warning";
  target?: AuditTarget;
  targetName?: string;
}

export interface AgentCacheUploadDeps {
  healthEventStore: HealthEventStore;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  recordRecordingFileFailure: (
    c: Context<AppBindings>,
    input: RecordingFileFailureInput,
  ) => Promise<void>;
  syncAndFindRecording: (recording: RecordingSummary) => Promise<RecordingSummary>;
  uploadDestinationStore: UploadDestinationStore;
}

export interface ChunkUploadInput {
  actor: NodeCredentialAuth;
  bytes: Buffer;
  chunkIndex: number;
  chunkTotal?: number;
  durationSeconds?: number;
  fileName?: string;
  job?: RecordingJob;
  jobId?: string;
  mimeType?: string;
  recording: RecordingSummary;
  rendition?: RecordingRendition;
}

// Parse the agent's 0-based `?chunk=` query param (matches the ffmpeg segment
// numbers). Returns undefined for the legacy whole-recording upload, "invalid"
// for a malformed value, else the 0-based wire index. The route converts it to
// the 1-based index used in storage and the chunk schema.
export function parseChunkIndex(value: string | undefined): number | "invalid" | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

export function parseChunkTotal(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// Offset of a chunk within the recording = sum of the durations of earlier chunks
// already stored. Chunks arrive in order, so earlier indices are present.
async function chunkOffsetSeconds(recordingId: string, index: number) {
  const chunks = await listRecordingChunksForRecording(recordingId);

  return chunks
    .filter((chunk) => chunk.index < index)
    .reduce((total, chunk) => total + chunk.durationSeconds, 0);
}

// The cache-file upload fan-out for both whole-recording and chunked recordings.
// Bundled here (out of the route module) to keep agent-routes under the LOC guard;
// closes over the route's stores + the two audit/health helpers.
export function createAgentCacheUploads(deps: AgentCacheUploadDeps) {
  const {
    healthEventStore,
    recordAuditEvent,
    recordingStore,
    recordRecordingFileFailure,
    syncAndFindRecording,
    uploadDestinationStore,
  } = deps;

  async function queueCachedRecordingUpload(
    c: Context<AppBindings>,
    actor: NodeCredentialAuth,
    recording: RecordingSummary,
  ) {
    const policies = await uploadPoliciesForCachedRecording(recording);
    const items: UploadQueueItem[] = [];

    for (const policy of policies) {
      const item = await queueCachedRecordingUploadForPolicy(c, actor, recording, policy);

      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  async function queueCachedRecordingUploadForPolicy(
    c: Context<AppBindings>,
    actor: NodeCredentialAuth,
    recording: RecordingSummary,
    policy: UploadPolicy,
  ) {
    try {
      const item = await enqueueRecordingUpload(
        recording,
        await uploadQueueInputForPolicy(
          policy,
          uploadDestinationStore,
          "policy_on_recording_cached",
        ),
      );

      await recordAuditEvent(c, {
        action: "recordings.upload_queue.auto_enqueue.succeeded",
        actor: nodeActor(actor),
        correlationIds: {
          recordingId: recording.id,
          uploadQueueItemId: item.id,
        },
        details: {
          provider: item.provider,
          target: item.target,
          trigger: policy.trigger,
          uploadPolicyId: policy.id,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return item;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "upload_queue_auto_enqueue_failed";
      const healthEvent = await healthEventStore.create({
        details: {
          reason,
          source: "cache_file_attach",
          uploadPolicyId: policy.id,
        },
        nodeId: actor.nodeId,
        recordingId: recording.id,
        severity: "warning",
        type: "controller.recording.upload_queue_failed",
      });

      await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
      await recordAuditEvent(c, {
        action: "recordings.upload_queue.auto_enqueue.failed",
        actor: nodeActor(actor),
        details: {
          healthEventId: healthEvent.id,
          uploadPolicyId: policy.id,
        },
        outcome: "failed",
        permission: "recording:control",
        reason,
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return undefined;
    }
  }

  // Attach one recording chunk: store + upsert the chunk row, enqueue its uploads
  // immediately (one per destination), and complete the job only on the final
  // chunk. Never flips the recording to cached per chunk — that happens once, on
  // the final chunk, after the whole capture is on the controller.
  async function handleChunkUpload(c: Context<AppBindings>, input: ChunkUploadInput) {
    const { actor, recording } = input;
    const before = recordingFileSnapshot(recording);

    // A chunk row must carry a non-empty owning jobId (the read schema enforces
    // `jobId.min(1)`). Reject an orphaned chunk upload (no job header + no job
    // row for the recording) up front rather than persisting `jobId: ""`, which
    // would throw a ZodError on the next chunk-store load and break the store.
    const jobIdForChunk = input.job?.id ?? input.jobId;

    if (!jobIdForChunk) {
      await recordRecordingFileFailure(c, {
        actor,
        createHealthEvent: false,
        reason: "chunk_upload_missing_job",
        recordingId: recording.id,
        targetName: recording.name,
      });

      return c.json({ error: "Chunk upload requires an owning recording job" }, 409);
    }

    const stored = await storeRecordingChunkFile(
      recording,
      input.chunkIndex,
      { bytes: input.bytes, fileName: input.fileName, mimeType: input.mimeType },
      input.rendition,
    ).catch(async (error: unknown) => {
      await recordRecordingFileFailure(c, {
        actor,
        createHealthEvent: true,
        jobId: input.jobId,
        reason: error instanceof Error ? error.message : "cache_write_failed",
        recordingId: recording.id,
        severity: "critical",
        targetName: recording.name,
      });
      throw error;
    });

    const existing = await findRecordingChunk(recording.id, input.chunkIndex);
    const chunk: RecordingChunk = existing ?? {
      createdAt: new Date().toISOString(),
      durationSeconds: 0,
      id: recordingChunkId(recording.id, input.chunkIndex),
      index: input.chunkIndex,
      jobId: jobIdForChunk,
      offsetSeconds: 0,
      recordingId: recording.id,
      status: "capturing",
    };

    chunk.jobId = jobIdForChunk;
    chunk.offsetSeconds = await chunkOffsetSeconds(recording.id, input.chunkIndex);
    const supplementary = applyStoredChunkRendition(
      chunk,
      stored,
      input.rendition,
      input.durationSeconds,
    );

    if (input.chunkTotal !== undefined) {
      chunk.total = input.chunkTotal;
    }
    if (!supplementary && !chunk.cachedAt) {
      chunk.cachedAt = new Date().toISOString();
    }
    await upsertRecordingChunk(chunk);

    const uploadQueueItems = supplementary
      ? []
      : await queueCachedChunkUpload(c, actor, recording, chunk, stored);
    let job: RecordingJob | undefined;

    // The final PRIMARY chunk carries the total: stamp it across the chunk rows,
    // mark the recording cached, and complete the capture job. A supplementary
    // rendition (e.g. `rendition=raw`) must NOT complete the job or flip the
    // recording to cached — this mirrors the whole-recording path's
    // `!supplementary` gate; only the primary rendition finalizes capture.
    if (!supplementary && input.chunkTotal !== undefined) {
      await setRecordingChunkTotal(recording.id, input.chunkTotal);
      await markRecordingCachedFromChunks(recording);
      job = input.job
        ? await completeRecordingJob(recording.id, input.job.id)
        : await completeRecordingJob(recording.id);
    }

    const syncedRecording = await syncAndFindRecording(recording);

    await recordAuditEvent(c, {
      action: "recordings.cache_file.attach.succeeded",
      actor: nodeActor(actor),
      after: recordingFileSnapshot(syncedRecording),
      before,
      details: {
        cachePath: stored.cachePath,
        checksum: stored.checksum,
        chunkIndex: input.chunkIndex,
        ...(input.chunkTotal !== undefined ? { chunkTotal: input.chunkTotal } : {}),
        fileName: stored.fileName,
        jobId: input.jobId,
        jobStatus: job?.status,
        rendition: input.rendition ?? "primary",
        size: stored.size,
        uploadQueueItemIds: uploadQueueItems.map((item) => item.id),
      },
      outcome: "succeeded",
      permission: "recording:control",
      target: { id: recording.id, name: recording.name, type: "recording" },
    });

    return c.json(
      { data: { chunk, file: stored, recording: syncedRecording, uploadQueueItems } },
      201,
    );
  }

  // On the final chunk the capture is complete: flip the recording to cached and
  // set its duration from the sum of chunk durations so the library reflects it.
  // Reconciliation later promotes it to uploaded/partial from the chunk uploads.
  async function markRecordingCachedFromChunks(recording: RecordingSummary) {
    const chunks = await listRecordingChunksForRecording(recording.id);
    const durationSeconds = chunks.reduce((total, chunk) => total + chunk.durationSeconds, 0);
    const status =
      recording.status === "uploaded" || recording.status === "partial"
        ? recording.status
        : "cached";

    recording.cached = true;
    recording.durationSeconds = durationSeconds > 0 ? durationSeconds : recording.durationSeconds;
    recording.status = status;
    await recordingStore.save(recording);
  }

  // Fan out one upload-queue item per enabled on_recording_cached policy for this
  // chunk, each pinned to its destination and carrying the chunk's own object.
  async function queueCachedChunkUpload(
    c: Context<AppBindings>,
    actor: NodeCredentialAuth,
    recording: RecordingSummary,
    chunk: RecordingChunk,
    stored: StoredRecordingFile,
  ) {
    const policies = await uploadPoliciesForChunkedRecording(recording);
    const items: UploadQueueItem[] = [];

    for (const policy of policies) {
      const item = await queueCachedChunkUploadForPolicy(
        c,
        actor,
        recording,
        chunk,
        stored,
        policy,
      );

      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  async function queueCachedChunkUploadForPolicy(
    c: Context<AppBindings>,
    actor: NodeCredentialAuth,
    recording: RecordingSummary,
    chunk: RecordingChunk,
    stored: StoredRecordingFile,
    policy: UploadPolicy,
  ) {
    try {
      const base = await uploadQueueInputForPolicy(
        policy,
        uploadDestinationStore,
        "policy_on_recording_cached",
      );
      const item = await enqueueRecordingUpload(recording, {
        ...base,
        cachePath: chunk.cachePath,
        checksum: chunk.checksum,
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        fileName: stored.fileName,
      });

      await recordAuditEvent(c, {
        action: "recordings.upload_queue.auto_enqueue.succeeded",
        actor: nodeActor(actor),
        correlationIds: {
          recordingId: recording.id,
          uploadQueueItemId: item.id,
        },
        details: {
          chunkIndex: chunk.index,
          provider: item.provider,
          target: item.target,
          trigger: policy.trigger,
          uploadPolicyId: policy.id,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return item;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "upload_queue_auto_enqueue_failed";
      const healthEvent = await healthEventStore.create({
        details: {
          chunkIndex: chunk.index,
          reason,
          source: "cache_file_attach",
          uploadPolicyId: policy.id,
        },
        nodeId: actor.nodeId,
        recordingId: recording.id,
        severity: "warning",
        type: "controller.recording.upload_queue_failed",
      });

      await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
      await recordAuditEvent(c, {
        action: "recordings.upload_queue.auto_enqueue.failed",
        actor: nodeActor(actor),
        details: {
          chunkIndex: chunk.index,
          healthEventId: healthEvent.id,
          uploadPolicyId: policy.id,
        },
        outcome: "failed",
        permission: "recording:control",
        reason,
        target: {
          id: recording.id,
          name: recording.name,
          type: "recording",
        },
      });

      return undefined;
    }
  }

  return { handleChunkUpload, queueCachedRecordingUpload };
}
