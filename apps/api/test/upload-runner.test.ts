import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-runner-"));
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(runnerRoot, "providers.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(runnerRoot, "queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
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

const allow: RequirePermission = () => async (_c, next) => {
  await next();
};

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

function recording(id = "rec_upload_runner_test"): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    checksum: `sha256:${id}`,
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
