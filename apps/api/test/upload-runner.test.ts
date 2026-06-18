import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-runner-"));
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(runnerRoot, "providers.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(runnerRoot, "queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createUploadProviderStore } = await import("../src/upload-providers.js");
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

function recording(): RecordingSummary {
  return {
    cachePath: "scheduled/rec_upload_runner_test.mp3",
    cached: true,
    checksum: "sha256:runner",
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id: "rec_upload_runner_test",
    name: "Council Meeting",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: ["council"],
  };
}
