import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const jobRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-job-lease-runner-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(jobRoot, "jobs.json");
process.env.RAKKR_RECORDING_METADATA_STORE_PATH = path.join(jobRoot, "recordings.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(jobRoot, "retention-policies.json");

const { createHealthEventStore } = await import("../src/health-store.js");
const { markAgentJobTerminalRecording } = await import("../src/agent-job-terminal-recording.js");
const { createRecordingJobLeaseRunner } = await import("../src/recording-job-lease-runner.js");
const { createRecordingStore } = await import("../src/recording-store.js");
const { claimRecordingJob, createRecordingJob, onRecordingJobLeaseExpired, recordingJob } =
  await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(jobRoot, { force: true, recursive: true });
});

test("recording job lease runner fails orphaned running jobs and syncs recording health", async () => {
  const previousLeaseSeconds = process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS;
  process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS = "1";
  const healthEventStore = createHealthEventStore("", []);
  const sourceRecording = recording();
  const recordingStore = createRecordingStore([sourceRecording]);
  const dispose = onRecordingJobLeaseExpired(async ({ job, terminalState }) => {
    const currentRecording = await recordingStore.find(job.recordingId);

    if (!currentRecording) {
      return;
    }

    await markAgentJobTerminalRecording(
      currentRecording,
      {
        jobId: job.id,
        reason: job.failureReason ?? "lease_expired",
        terminalState,
      },
      { healthEventStore, recordingStore },
    );
  });
  const job = await createRecordingJob(sourceRecording);
  const claimed = await claimRecordingJob(job.id, sourceRecording.nodeId);
  const runner = createRecordingJobLeaseRunner();

  try {
    assert.equal(claimed?.status, "running");

    await runner.runOnce(new Date(Date.now() + 2_000));

    const expired = await recordingJob(job.id);
    const updatedRecording = await recordingStore.find(sourceRecording.id);
    const [healthEvent] = await healthEventStore.list({ recordingId: sourceRecording.id });

    assert.equal(expired?.status, "failed");
    assert.equal(expired?.failureReason, "lease_expired");
    assert.equal(updatedRecording?.status, "failed");
    assert.equal(updatedRecording?.healthStatus, "critical");
    assert.equal(healthEvent?.type, "controller.recording.job_failed");
    assert.equal(healthEvent?.severity, "critical");
    assert.equal(healthEvent?.details.jobId, job.id);
    assert.equal(healthEvent?.details.reason, "lease_expired");
  } finally {
    dispose();
    runner.stop();

    if (previousLeaseSeconds === undefined) {
      delete process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS;
    } else {
      process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS = previousLeaseSeconds;
    }
  }
});

function recording(): RecordingSummary {
  const id = `rec_lease_runner_${randomUUID()}`;

  return {
    cached: false,
    durationSeconds: 0,
    folder: "tests",
    healthStatus: "unknown",
    id,
    name: "Lease Runner Recovery",
    nodeId: "node_lease_runner",
    recordedAt: "2026-06-25T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: ["recovery"],
  };
}
