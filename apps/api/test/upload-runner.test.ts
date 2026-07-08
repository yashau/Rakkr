import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  cacheRecording,
  createAuditStore,
  createHealthEventStore,
  createUploadDestinationStore,
  createUploadPolicy,
  createUploadRunner,
  enqueueRecordingUpload,
  fakeSmbClient,
  memoryRecordingStore,
  recording,
  runnerRoot,
  sha256Prefixed,
  throwingSmbClient,
  upsertRecordingChunk,
} from "./upload-runner-harness.js";

test("upload runner processes queue items and records service audit events", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const runner = createUploadRunner({ auditStore, limit: 5, destinationStore });

  await enqueueRecordingUpload(recording(), {
    provider: "stub",
    target: "stub://queue-only",
  });

  const summary = await runner.runOnce();
  const runEvents = await auditStore.list({
    action: "recordings.upload_queue.runner.completed",
  });
  const itemEvents = await auditStore.list({
    action: "recordings.upload_queue.runner_item.succeeded",
  });

  assert.equal(summary.attempted, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(runEvents.length, 1);
  assert.equal(runEvents[0]?.actor.id, "system:upload-runner");
  assert.equal(runEvents[0]?.outcome, "succeeded");
  assert.equal(runEvents[0]?.details.succeeded, 1);
  assert.equal(itemEvents.length, 1);
  assert.equal(itemEvents[0]?.target.id, "rec_upload_runner_test");
});

test("upload runner deletes local cache after confirmed upload when policy requests it", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "archive-bytes";
  const cachedRecording = recording("rec_upload_retention_test", contents);
  const cachePath = await cacheRecording(cachedRecording.id, contents);
  const recordingStore = memoryRecordingStore([cachedRecording]);
  const smb = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    limit: 5,
    destinationStore,
    recordingStore,
    smbClientFactory: () => smb.client,
  });

  const destination = await destinationStore.create({
    displayName: "Retention Share",
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
    name: "Archive then delete cache",
    trigger: "manual",
  });
  await enqueueRecordingUpload(cachedRecording, {
    destinationId: destination.id,
    maxAttempts: 1,
    policyId: policy.id,
    provider: "smb",
  });

  const summary = await runner.runOnce();
  const updated = await recordingStore.find(cachedRecording.id);
  const reconcileEvents = await auditStore.list({
    action: "recordings.upload_queue.reconciled.succeeded",
  });
  const itemEvents = await auditStore.list({
    action: "recordings.upload_queue.runner_item.succeeded",
  });

  assert.equal(summary.succeeded, 1);
  assert.equal(smb.files.get("recordings/Council Meeting.mp3")?.toString("utf8"), "archive-bytes");
  await assert.rejects(readFile(cachePath), /ENOENT/);
  assert.equal(updated?.cached, false);
  assert.equal(updated?.cachePath, undefined);
  assert.equal(updated?.checksum, cachedRecording.checksum);
  assert.equal(updated?.status, "uploaded");
  // Cache deletion is reported on the recording-level reconciliation event.
  assert.deepEqual(reconcileEvents[0]?.details.retention, {
    cacheDeleted: true,
    policyId: policy.id,
  });
  assert.equal(reconcileEvents[0]?.details.status, "uploaded");
  assert.deepEqual(itemEvents[0]?.details.checksumVerification, {
    algorithm: "sha256",
    expected: sha256Prefixed(contents),
    method: "file_copy_sha256",
    observed: sha256Prefixed(contents),
    status: "matched",
  });
});

test("upload runner records health events for terminal upload failures", async () => {
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("");
  const destinationStore = createUploadDestinationStore();
  const failedRecording = recording("rec_upload_runner_terminal_failure");
  const recordingStore = memoryRecordingStore([failedRecording]);
  const runner = createUploadRunner({
    auditStore,
    healthEventStore,
    limit: 5,
    destinationStore,
    recordingStore,
    smbClientFactory: () => {
      throw new Error("smb_connect_failed");
    },
  });

  const destination = await destinationStore.create({
    displayName: "Failure Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  await enqueueRecordingUpload(failedRecording, {
    destinationId: destination.id,
    maxAttempts: 1,
    provider: "smb",
  });

  const summary = await runner.runOnce();
  const events = await healthEventStore.list({
    recordingId: failedRecording.id,
    type: "controller.recording.upload_queue_failed",
  });
  const itemEvents = await auditStore.list({
    action: "recordings.upload_queue.runner_item.failed",
  });
  const updated = await recordingStore.find(failedRecording.id);

  assert.equal(summary.failed, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.severity, "warning");
  assert.equal(events[0]?.details.source, "upload_runner");
  assert.equal(events[0]?.details.provider, "smb");
  assert.equal(events[0]?.details.uploadQueueItemId, summary.items[0]?.itemId);
  assert.equal(updated?.healthStatus, "warning");
  assert.equal(itemEvents[0]?.details.healthEventId, events[0]?.id);
});

test("upload runner marks recordings partial when one destination fails", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "partial-bytes";
  const partialRecording = recording("rec_upload_partial", contents);
  const cachePath = await cacheRecording(partialRecording.id, contents);
  const recordingStore = memoryRecordingStore([partialRecording]);
  const good = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    destinationStore,
    limit: 5,
    recordingStore,
    smbClientFactory: (config) =>
      config.smb?.server === "good.example.lan" ? good.client : throwingSmbClient(),
  });

  const goodDestination = await destinationStore.create({
    displayName: "Good Share",
    enabled: true,
    kind: "smb",
    smb: { server: "good.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const badDestination = await destinationStore.create({
    displayName: "Bad Share",
    enabled: true,
    kind: "smb",
    smb: { server: "bad.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  await enqueueRecordingUpload(partialRecording, {
    destinationId: goodDestination.id,
    maxAttempts: 1,
    provider: "smb",
  });
  await enqueueRecordingUpload(partialRecording, {
    destinationId: badDestination.id,
    maxAttempts: 1,
    provider: "smb",
  });

  await runner.runOnce();
  const updated = await recordingStore.find(partialRecording.id);
  const reconcile = await auditStore.list({
    action: "recordings.upload_queue.reconciled.partial",
  });

  // One destination succeeded, the other failed: the recording is partial, not
  // failed, and the shared cache is retained because no policy deletes it.
  assert.equal(updated?.status, "partial");
  assert.equal(updated?.cached, true);
  await assert.doesNotReject(readFile(cachePath));
  assert.equal(reconcile[0]?.details.succeeded, 1);
  assert.equal(reconcile[0]?.details.failed, 1);
  assert.equal(reconcile[0]?.outcome, "partial");
});

test("upload runner keeps cache for partial uploads even when a succeeded policy deletes cache", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "partial-retain-bytes";
  const partialRecording = recording("rec_upload_partial_retain", contents);
  const cachePath = await cacheRecording(partialRecording.id, contents);
  const recordingStore = memoryRecordingStore([partialRecording]);
  const good = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    destinationStore,
    limit: 5,
    recordingStore,
    smbClientFactory: (config) =>
      config.smb?.server === "good.example.lan" ? good.client : throwingSmbClient(),
  });

  const goodDestination = await destinationStore.create({
    displayName: "Good Share",
    enabled: true,
    kind: "smb",
    smb: { server: "good.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const badDestination = await destinationStore.create({
    displayName: "Bad Share",
    enabled: true,
    kind: "smb",
    smb: { server: "bad.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  // The succeeding destination's policy asks to delete the shared cache; the
  // other destination fails and stays retryable. The shared cache is the only
  // source for that retry, so it must be preserved until every destination is
  // confirmed — deleting it on the strength of one success is data loss.
  const deletePolicy = await createUploadPolicy({
    deleteCacheAfterUpload: true,
    destinationId: goodDestination.id,
    enabled: true,
    maxAttempts: 1,
    name: "Archive then delete cache",
    trigger: "manual",
  });
  await enqueueRecordingUpload(partialRecording, {
    destinationId: goodDestination.id,
    maxAttempts: 1,
    policyId: deletePolicy.id,
    provider: "smb",
  });
  await enqueueRecordingUpload(partialRecording, {
    destinationId: badDestination.id,
    maxAttempts: 1,
    provider: "smb",
  });

  await runner.runOnce();
  const updated = await recordingStore.find(partialRecording.id);

  assert.equal(updated?.status, "partial");
  assert.equal(updated?.cached, true);
  assert.equal(updated?.cachePath, partialRecording.cachePath);
  await assert.doesNotReject(readFile(cachePath));
});

test("upload runner keeps a chunk's cache when one destination fails (chunked recordings)", async () => {
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const contents = "chunk-retain-bytes";
  const chunkedRecording = recording("rec_upload_chunk_retain", contents);
  const recordingStore = memoryRecordingStore([chunkedRecording]);
  const chunkId = "rec_upload_chunk_retain:1";
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
    jobId: "job_chunk_retain",
    offsetSeconds: 0,
    recordingId: chunkedRecording.id,
    status: "cached",
    total: 1,
  });

  const good = fakeSmbClient();
  const runner = createUploadRunner({
    auditStore,
    destinationStore,
    limit: 5,
    recordingStore,
    smbClientFactory: (config) =>
      config.smb?.server === "good.example.lan" ? good.client : throwingSmbClient(),
  });

  const goodDestination = await destinationStore.create({
    displayName: "Good Share",
    enabled: true,
    kind: "smb",
    smb: { server: "good.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const badDestination = await destinationStore.create({
    displayName: "Bad Share",
    enabled: true,
    kind: "smb",
    smb: { server: "bad.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const deletePolicy = await createUploadPolicy({
    deleteCacheAfterUpload: true,
    destinationId: goodDestination.id,
    enabled: true,
    maxAttempts: 1,
    name: "Archive chunk then delete cache",
    trigger: "manual",
  });
  await enqueueRecordingUpload(chunkedRecording, {
    cachePath: chunkCacheRel,
    chunkId,
    chunkIndex: 1,
    destinationId: goodDestination.id,
    fileName: "chunk-1.mp3",
    maxAttempts: 1,
    policyId: deletePolicy.id,
    provider: "smb",
  });
  await enqueueRecordingUpload(chunkedRecording, {
    cachePath: chunkCacheRel,
    chunkId,
    chunkIndex: 1,
    destinationId: badDestination.id,
    fileName: "chunk-1.mp3",
    maxAttempts: 1,
    provider: "smb",
  });

  await runner.runOnce();

  // The bad destination is still retryable and the chunk's cached object is its
  // only source, so it must survive even though the good destination's policy
  // deletes cache — the chunk analogue of the whole-recording partial gate.
  await assert.doesNotReject(readFile(chunkCachePath));
});
