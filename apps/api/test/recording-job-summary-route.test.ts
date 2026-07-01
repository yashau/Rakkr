import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, RecordingJob, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import { memoryRecordingStore } from "./recording-store-mock.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-job-summary-route-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createRecordingJob, failRecordingJob } = await import("../src/recording-jobs.js");
const { registerRecordingJobRoutes } = await import("../src/recording-job-routes.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("G74: job list summary counts the full filtered set, not just the page", async () => {
  const prefix = `summary_${randomUUID()}`;
  const recordings = [
    recordingSummary({ id: `rec_${prefix}_a`, nodeId: `${prefix}_node` }),
    recordingSummary({ id: `rec_${prefix}_b`, nodeId: `${prefix}_node` }),
    recordingSummary({ id: `rec_${prefix}_c`, nodeId: `${prefix}_node` }),
    recordingSummary({ id: `rec_${prefix}_d`, nodeId: `${prefix}_node` }),
  ];
  const recordingStore = memoryRecordingStore(recordings);
  const jobs: RecordingJob[] = [];
  for (const recording of recordings) {
    jobs.push(await createRecordingJob(recording, { captureDevice: `${prefix}:capture` }));
  }
  // Fail one so the breakdown is non-trivial: three queued + one failed.
  await failRecordingJob((jobs[3] as RecordingJob).id, "capture_failed");

  const app = jobRoutesApp(recordingStore);
  // A page size of 1 forces the returned page far smaller than the matching set.
  const response = await app.request(`/api/v1/recording-jobs?search=${prefix}&limit=1`);
  const body = (await response.json()) as {
    data: RecordingJob[];
    meta: { total: number };
    summary: { failed: number; queued: number; total: number };
  };

  assert.equal(response.status, 200);
  // Only one job on the page, but the summary reflects all four matching jobs —
  // pre-fix the tiles were computed over the returned page and undercounted.
  assert.equal(body.data.length, 1);
  assert.equal(body.meta.total, 4);
  assert.equal(body.summary.total, 4);
  assert.equal(body.summary.queued, 3);
  assert.equal(body.summary.failed, 1);
});

function jobRoutesApp(recordingStore: ReturnType<typeof memoryRecordingStore>) {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");

  registerRecordingJobRoutes({
    app,
    currentAuth: () => ({ user: currentUser() }),
    currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission,
    scopedRecordings: () => recordingStore.list(),
  });

  return app;
}

const requirePermission: RequirePermission = () => async (_c, next) => {
  await next();
};

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_job_summary",
        name: "Job Summary User",
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

function currentUser() {
  return {
    email: "job-summary@example.test",
    groups: [],
    id: "user_job_summary",
    name: "Job Summary User",
    permissions: ["recording:read" as const],
    provider: "local" as const,
    resourceGrants: [],
    roles: ["operator" as const],
  };
}

function recordingSummary(input: Partial<RecordingSummary>): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: `rec_${randomUUID()}`,
    name: "Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: ["voice"],
    ...input,
  };
}
