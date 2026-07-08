import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AppBindings } from "../src/http-types.js";
import {
  allow,
  createAuditStore,
  createUploadDestinationStore,
  createUploadRunner,
  denyMissingPermission,
  enqueueRecordingUpload,
  listUploadQueueItems,
  recordAuditEvent,
  recording,
  registerUploadRunnerRoutes,
  user,
  viewer,
} from "./upload-runner-harness.js";

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
