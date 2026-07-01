import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import { memoryRecordingStore } from "./recording-store-mock.js";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-runner-"));
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(runnerRoot, "destinations.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(runnerRoot, "policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(runnerRoot, "queue.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(runnerRoot, "cache");
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(runnerRoot, "chunks.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");
const { registerUploadRunnerRoutes } = await import("../src/upload-runner-routes.js");
const { createUploadRunner } = await import("../src/upload-runner.js");
const { enqueueRecordingUpload, listUploadQueueItems } = await import("../src/upload-queue.js");
const { upsertRecordingChunk } = await import("../src/recording-chunks.js");

test.after(async () => {
  await rm(runnerRoot, { force: true, recursive: true });
});

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

test("upload runner routes expose status and run-now control", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const runner = createUploadRunner({ auditStore, limit: 5, destinationStore });

  registerUploadRunnerRoutes({
    app,
    currentAuth: () => ({ user: user() }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allow,
    uploadRunner: runner,
  });
  await enqueueRecordingUpload(recording("rec_upload_runner_route_test"), {
    provider: "stub",
    target: "stub://queue-only",
  });

  const before = await app.request("/api/v1/upload-runner");
  const actions = await app.request("/api/v1/upload-runner/actions");
  const run = await app.request("/api/v1/upload-runner/run", { method: "POST" });
  const actionPayload = (await actions.json()) as {
    data: { actions: { run: { enabled: boolean; href?: string } } };
  };
  const payload = await run.json();
  const readEvents = await auditStore.list({
    action: "recordings.upload_runner.read.succeeded",
  });
  const actionEvents = await auditStore.list({
    action: "recordings.upload_runner.actions.read.succeeded",
  });
  const events = await auditStore.list({ action: "recordings.upload_runner.run.succeeded" });

  assert.equal(before.status, 200);
  assert.equal(actions.status, 200);
  assert.equal(actionPayload.data.actions.run.enabled, true);
  assert.equal(actionPayload.data.actions.run.href, "/api/v1/upload-runner/run");
  assert.equal(run.status, 200);
  assert.equal(payload.summary.succeeded, 1);
  assert.equal(payload.data.lastSummary.succeeded, 1);
  assert.equal(readEvents.length, 1);
  assert.equal(readEvents[0]?.permission, "recording:read");
  assert.equal(readEvents[0]?.target.type, "upload_runner");
  assert.equal(readEvents[0]?.details.started, false);
  assert.equal(readEvents[0]?.details.lastSummaryAttempted, 0);
  assert.equal(actionEvents.length, 1);
  assert.equal(actionEvents[0]?.permission, "recording:read");
  assert.equal(actionEvents[0]?.target.type, "upload_runner");
  assert.equal(actionEvents[0]?.details.started, false);
  assert.equal(actionEvents[0]?.details.visibleActionCount, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actor.id, "user_upload_runner_test");
});

test("upload runner run route only processes queue items for scoped recordings", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const runner = createUploadRunner({ auditStore, limit: 5, destinationStore });
  const visible = recording(`rec_upload_visible_${randomUUID()}`);
  const hidden = recording(`rec_upload_hidden_${randomUUID()}`);
  const visibleItem = await enqueueRecordingUpload(visible, {
    provider: "stub",
    target: "stub://visible",
  });
  const hiddenItem = await enqueueRecordingUpload(hidden, {
    provider: "stub",
    target: "stub://hidden",
  });

  registerUploadRunnerRoutes({
    app,
    currentAuth: () => ({ user: user() }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allow,
    scopedRecordings: async () => [visible],
    uploadRunner: runner,
  });

  const response = await app.request("/api/v1/upload-runner/run", { method: "POST" });
  const body = (await response.json()) as {
    summary: { attempted: number; items: Array<{ recordingId: string }>; succeeded: number };
  };
  const items = await listUploadQueueItems();
  const storedVisible = items.find((item) => item.id === visibleItem.id);
  const storedHidden = items.find((item) => item.id === hiddenItem.id);
  const itemEvents = await auditStore.list({
    action: "recordings.upload_queue.runner_item.succeeded",
  });

  assert.equal(response.status, 200);
  assert.equal(body.summary.attempted, 1);
  assert.equal(body.summary.succeeded, 1);
  assert.deepEqual(
    body.summary.items.map((item) => item.recordingId),
    [visible.id],
  );
  assert.equal(storedVisible?.status, "succeeded");
  assert.equal(storedHidden?.status, "queued");
  assert.equal(storedHidden?.attemptCount, 0);
  assert.deepEqual(
    itemEvents.map((event) => event.target.id),
    [visible.id],
  );
});

test("upload runner status routes hide last-summary items outside scoped recordings", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const runner = createUploadRunner({ auditStore, limit: 5, destinationStore });
  const visible = recording(`rec_upload_status_visible_${randomUUID()}`);
  const hidden = recording(`rec_upload_status_hidden_${randomUUID()}`);

  await enqueueRecordingUpload(visible, {
    provider: "stub",
    target: "stub://visible",
  });
  await enqueueRecordingUpload(hidden, {
    provider: "stub",
    target: "stub://hidden",
  });
  await runner.runOnce();

  registerUploadRunnerRoutes({
    app,
    currentAuth: () => ({ user: user() }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allow,
    scopedRecordings: async () => [visible],
    uploadRunner: runner,
  });

  const statusResponse = await app.request("/api/v1/upload-runner");
  const actionsResponse = await app.request("/api/v1/upload-runner/actions");
  const statusBody = (await statusResponse.json()) as {
    data: { lastSummary?: { attempted: number; items: Array<{ recordingId: string }> } };
  };
  const actionsBody = (await actionsResponse.json()) as {
    data: {
      status: { lastSummary?: { attempted: number; items: Array<{ recordingId: string }> } };
    };
  };
  const [readEvent] = await auditStore.list({
    action: "recordings.upload_runner.read.succeeded",
  });
  const [actionEvent] = await auditStore.list({
    action: "recordings.upload_runner.actions.read.succeeded",
  });

  assert.equal(statusResponse.status, 200);
  assert.equal(actionsResponse.status, 200);
  assert.ok((runner.status().lastSummary?.attempted ?? 0) > 1);
  assert.equal(statusBody.data.lastSummary?.attempted, 1);
  assert.deepEqual(
    statusBody.data.lastSummary?.items.map((item) => item.recordingId),
    [visible.id],
  );
  assert.deepEqual(actionsBody.data.status.lastSummary, statusBody.data.lastSummary);
  assert.equal(readEvent?.details.lastSummaryAttempted, 1);
  assert.equal(readEvent?.details.lastSummaryItemCount, 1);
  assert.equal(actionEvent?.details.lastSummaryAttempted, 1);
  assert.equal(actionEvent?.details.lastSummaryItemCount, 1);
});

test("upload runner routes deny users without required permissions", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const runner = createUploadRunner({ auditStore, limit: 5, destinationStore });

  registerUploadRunnerRoutes({
    app,
    currentAuth: () => ({ user: viewer() }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore),
    uploadRunner: runner,
  });
  await enqueueRecordingUpload(recording("rec_upload_runner_denied_route_test"), {
    provider: "stub",
    target: "stub://queue-only",
  });

  const readResponse = await app.request("/api/v1/upload-runner");
  const actionsResponse = await app.request("/api/v1/upload-runner/actions");
  const runResponse = await app.request("/api/v1/upload-runner/run", { method: "POST" });
  const status = runner.status();
  const events = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    [readResponse.status, actionsResponse.status, runResponse.status],
    [403, 403, 403],
  );
  assert.equal(status.lastSummary, undefined);
  assert.deepEqual(
    Object.fromEntries(events.map((event) => [event.action, event.permission]).sort()),
    {
      "recordings.upload_runner.actions.read": "recording:read",
      "recordings.upload_runner.read": "recording:read",
      "recordings.upload_runner.run": "recording:control",
    },
  );
  assert.ok(events.every((event) => event.reason === "missing_permission"));
  assert.ok(events.every((event) => event.target.type === "upload_runner"));
});

test("upload runner action summary reports missing control permission", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const destinationStore = createUploadDestinationStore();
  const runner = createUploadRunner({ auditStore, limit: 5, destinationStore });

  registerUploadRunnerRoutes({
    app,
    currentAuth: () => ({ user: viewer(["recording:read"]) }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allow,
    uploadRunner: runner,
  });

  const response = await app.request("/api/v1/upload-runner/actions");
  const body = (await response.json()) as {
    data: { actions: { run: { enabled: boolean; reason?: string } } };
  };
  const [event] = await auditStore.list({
    action: "recordings.upload_runner.actions.read.succeeded",
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.actions.run.enabled, false);
  assert.equal(body.data.actions.run.reason, "missing_permission");
  assert.equal(event?.outcome, "succeeded");
  assert.equal(event?.details.visibleActionCount, 2);
});

const allow: RequirePermission = () => async (_c, next) => {
  await next();
};

function denyMissingPermission(auditStore: ReturnType<typeof createAuditStore>): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: viewer() },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: ["viewer"],
      },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const actor = input.actor ?? {
      id: input.auth?.user?.id ?? "anonymous",
      name: input.auth?.user?.name ?? "Anonymous",
      roles: input.auth?.user?.roles ?? [],
      type: "user" as const,
    };
    const event: AuditEvent = {
      action: input.action,
      actor,
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

function user(): CurrentUser {
  return {
    email: "upload-runner@example.com",
    groups: [],
    id: "user_upload_runner_test",
    name: "Upload Runner Test",
    permissions: ["recording:control", "recording:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["admin"],
  };
}

function viewer(permissions: CurrentUser["permissions"] = []): CurrentUser {
  return {
    email: "upload-runner-viewer@example.com",
    groups: [],
    id: "user_upload_runner_viewer_test",
    name: "Upload Runner Viewer Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function recording(id = "rec_upload_runner_test", contents?: string): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    checksum: contents ? sha256Prefixed(contents) : `sha256:${id}`,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id,
    name: "Council Meeting",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: ["council"],
  };
}

async function cacheRecording(id: string, contents: string) {
  const cachePath = path.join(runnerRoot, "cache", "scheduled", `${id}.mp3`);

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents);

  return cachePath;
}

function sha256Prefixed(contents: string) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function throwingSmbClient() {
  return {
    async close() {},
    async connect() {
      throw new Error("smb_connect_failed");
    },
    async mkdir() {},
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
  };
}

function fakeSmbClient() {
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];

  return {
    client: {
      async close() {},
      async connect() {},
      async mkdir(targetPath: string) {
        dirs.push(targetPath);
      },
      async readFile(targetPath: string) {
        const data = files.get(targetPath);

        if (!data) {
          const error = new Error("ENOENT") as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        }

        return data;
      },
      async writeFile(targetPath: string, data: Buffer | string) {
        files.set(targetPath, Buffer.from(data));
      },
    },
    dirs,
    files,
  };
}
