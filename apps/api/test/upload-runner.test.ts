import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-runner-"));
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(runnerRoot, "providers.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(runnerRoot, "policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(runnerRoot, "queue.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(runnerRoot, "cache");

const { createAuditStore } = await import("../src/audit-store.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadProviderStore } = await import("../src/upload-providers.js");
const { registerUploadRunnerRoutes } = await import("../src/upload-runner-routes.js");
const { createUploadRunner } = await import("../src/upload-runner.js");
const { enqueueRecordingUpload } = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(runnerRoot, { force: true, recursive: true });
});

test("upload runner processes queue items and records service audit events", async () => {
  const auditStore = createAuditStore("");
  const providerStore = createUploadProviderStore();
  const runner = createUploadRunner({ auditStore, limit: 5, providerStore });

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
  const providerStore = createUploadProviderStore();
  const uploadedRoot = path.join(runnerRoot, "retention-share");
  const contents = "archive-bytes";
  const cachedRecording = recording("rec_upload_retention_test", contents);
  const cachePath = await cacheRecording(cachedRecording.id, contents);
  const recordingStore = memoryRecordingStore([cachedRecording]);
  const runner = createUploadRunner({
    auditStore,
    limit: 5,
    providerStore,
    recordingStore,
  });

  await providerStore.update("smb", {
    displayName: "Retention Share",
    enabled: true,
    target: uploadedRoot,
  });
  const policy = await createUploadPolicy({
    deleteCacheAfterUpload: true,
    enabled: true,
    maxAttempts: 1,
    name: "Archive then delete cache",
    provider: "smb",
    target: uploadedRoot,
    trigger: "manual",
  });
  await enqueueRecordingUpload(cachedRecording, {
    maxAttempts: 1,
    policyId: policy.id,
    provider: "smb",
    target: uploadedRoot,
  });

  const summary = await runner.runOnce();
  const updated = await recordingStore.find(cachedRecording.id);
  const itemEvents = await auditStore.list({
    action: "recordings.upload_queue.runner_item.succeeded",
  });

  assert.equal(summary.succeeded, 1);
  assert.equal(
    await readFile(path.join(uploadedRoot, "Council Meeting.mp3"), "utf8"),
    "archive-bytes",
  );
  await assert.rejects(readFile(cachePath), /ENOENT/);
  assert.equal(updated?.cached, false);
  assert.equal(updated?.cachePath, undefined);
  assert.equal(updated?.checksum, cachedRecording.checksum);
  assert.equal(updated?.status, "uploaded");
  assert.deepEqual(itemEvents[0]?.details.retention, {
    cacheDeleted: true,
    policyId: policy.id,
  });
  assert.deepEqual(itemEvents[0]?.details.checksumVerification, {
    algorithm: "sha256",
    expected: sha256Prefixed(contents),
    method: "file_copy_sha256",
    observed: sha256Prefixed(contents),
    status: "matched",
  });
});

test("upload runner routes expose status and run-now control", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const providerStore = createUploadProviderStore();
  const runner = createUploadRunner({ auditStore, limit: 5, providerStore });

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
  const run = await app.request("/api/v1/upload-runner/run", { method: "POST" });
  const payload = await run.json();
  const events = await auditStore.list({ action: "recordings.upload_runner.run.succeeded" });

  assert.equal(before.status, 200);
  assert.equal(run.status, 200);
  assert.equal(payload.summary.succeeded, 1);
  assert.equal(payload.data.lastSummary.succeeded, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actor.id, "user_upload_runner_test");
});

test("upload runner run-now route denies users without recording control", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const providerStore = createUploadProviderStore();
  const runner = createUploadRunner({ auditStore, limit: 5, providerStore });

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

  const response = await app.request("/api/v1/upload-runner/run", { method: "POST" });
  const status = runner.status();
  const events = await auditStore.list({ action: "recordings.upload_runner.run" });

  assert.equal(response.status, 403);
  assert.equal(status.lastSummary, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, "denied");
  assert.equal(events[0]?.permission, "recording:control");
  assert.equal(events[0]?.reason, "missing_permission");
  assert.equal(events[0]?.target.type, "upload_runner");
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

function viewer(): CurrentUser {
  return {
    email: "upload-runner-viewer@example.com",
    groups: [],
    id: "user_upload_runner_viewer_test",
    name: "Upload Runner Viewer Test",
    permissions: ["recording:read"],
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

function memoryRecordingStore(recordings: RecordingSummary[]) {
  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
    async delete(recordingId: string) {
      const index = recordings.findIndex((recording) => recording.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId: string) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording: RecordingSummary) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
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
