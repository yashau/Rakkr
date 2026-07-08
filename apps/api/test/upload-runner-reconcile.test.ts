import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  cacheRecording,
  createAuditStore,
  createUploadDestinationStore,
  createUploadPolicy,
  createUploadRunner,
  enqueueRecordingUpload,
  fakeSmbClient,
  memoryRecordingStore,
  recording,
  runnerRoot,
  upsertRecordingChunk,
} from "./upload-runner-harness.js";

test("G54: reconcile does not overwrite a recording a retry reset to `recording`", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "retry-race-bytes";
  // Mid-retry: the recording was reset to `recording`, but a prior attempt left
  // a settled upload-queue item the reconcile would otherwise promote.
  const retried = {
    ...recording("rec_upload_retry_race", contents),
    status: "recording" as const,
  };
  const cachePath = await cacheRecording(retried.id, contents);
  const recordingStore = memoryRecordingStore([retried]);
  const smb = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    destinationStore,
    limit: 5,
    recordingStore,
    smbClientFactory: () => smb.client,
  });

  const destination = await destinationStore.create({
    displayName: "Race Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const policy = await createUploadPolicy({
    deleteCacheAfterUpload: true,
    destinationId: destination.id,
    enabled: true,
    maxAttempts: 1,
    name: "Race then delete cache",
    trigger: "manual",
  });
  await enqueueRecordingUpload(retried, {
    destinationId: destination.id,
    maxAttempts: 1,
    policyId: policy.id,
    provider: "smb",
  });

  await runner.runOnce();
  const updated = await recordingStore.find(retried.id);

  // Pre-fix the reconcile blind-saved "uploaded" over the retry's fresh state
  // and deleted its cache; now it re-reads and skips.
  assert.equal(updated?.status, "recording");
  await assert.doesNotReject(readFile(cachePath));
});

test("G55: chunked reconcile does not promote a recording reset to `recording`", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "chunk-race-bytes";
  const retried = {
    ...recording("rec_upload_chunk_race", contents),
    status: "recording" as const,
  };
  const recordingStore = memoryRecordingStore([retried]);
  const chunkId = "rec_upload_chunk_race:1";
  const chunkCacheRel = `chunks/${chunkId}.mp3`;
  const chunkCachePath = path.join(runnerRoot, "cache", chunkCacheRel);

  await mkdir(path.dirname(chunkCachePath), { recursive: true });
  await writeFile(chunkCachePath, contents);
  await upsertRecordingChunk({
    cachePath: chunkCacheRel,
    createdAt: "2026-06-18T12:00:00.000Z",
    durationSeconds: 60,
    id: chunkId,
    index: 1,
    jobId: "job_chunk_race",
    offsetSeconds: 0,
    recordingId: retried.id,
    status: "cached",
    total: 1,
  });

  const smb = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    destinationStore,
    limit: 5,
    recordingStore,
    smbClientFactory: () => smb.client,
  });

  const destination = await destinationStore.create({
    displayName: "Chunk Race Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const policy = await createUploadPolicy({
    deleteCacheAfterUpload: false,
    destinationId: destination.id,
    enabled: true,
    maxAttempts: 1,
    name: "Chunk race policy",
    trigger: "manual",
  });
  await enqueueRecordingUpload(retried, {
    cachePath: chunkCacheRel,
    chunkId,
    chunkIndex: 1,
    destinationId: destination.id,
    fileName: "chunk-1.mp3",
    maxAttempts: 1,
    policyId: policy.id,
    provider: "smb",
  });

  await runner.runOnce();
  const updated = await recordingStore.find(retried.id);

  // Pre-fix the chunked reconcile blind-saved "uploaded" over the retry state.
  assert.equal(updated?.status, "recording");
});

test("G55-d: a stale chunked reconcile does not delete a re-captured chunk's cache", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "chunk-recapture-bytes";
  const retried = {
    ...recording("rec_upload_chunk_recapture", contents),
    status: "recording" as const,
  };
  const recordingStore = memoryRecordingStore([retried]);
  const chunkId = "rec_upload_chunk_recapture:1";
  const chunkCacheRel = `chunks/${chunkId}.mp3`;
  const chunkCachePath = path.join(runnerRoot, "cache", chunkCacheRel);

  await mkdir(path.dirname(chunkCachePath), { recursive: true });
  await writeFile(chunkCachePath, contents);
  await upsertRecordingChunk({
    cachePath: chunkCacheRel,
    createdAt: "2026-06-18T12:00:00.000Z",
    durationSeconds: 60,
    id: chunkId,
    index: 1,
    jobId: "job_chunk_recapture",
    offsetSeconds: 0,
    recordingId: retried.id,
    status: "cached",
    total: 1,
  });

  const smb = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    destinationStore,
    limit: 5,
    recordingStore,
    smbClientFactory: () => smb.client,
  });
  const destination = await destinationStore.create({
    displayName: "Recapture Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const policy = await createUploadPolicy({
    deleteCacheAfterUpload: true,
    destinationId: destination.id,
    enabled: true,
    maxAttempts: 1,
    name: "Recapture delete policy",
    trigger: "manual",
  });
  await enqueueRecordingUpload(retried, {
    cachePath: chunkCacheRel,
    chunkId,
    chunkIndex: 1,
    destinationId: destination.id,
    fileName: "chunk-1.mp3",
    maxAttempts: 1,
    policyId: policy.id,
    provider: "smb",
  });

  await runner.runOnce();

  // Pre-fix the per-chunk deletion ran before the recording-status guard, so a
  // stale pass (recording reset to `recording` by a retry) deleted the
  // re-captured chunk's cache. The hoisted guard now skips the whole pass.
  await assert.doesNotReject(readFile(chunkCachePath));
});
