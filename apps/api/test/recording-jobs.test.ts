import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const jobRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-jobs-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(jobRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(jobRoot, "retention-policies.json");

const {
  claimNextRecordingGroup,
  claimRecordingJob,
  completeRecordingJob,
  createRecordingJob,
  expireRecordingJobLeases,
  failRecordingJob,
  onRecordingJobLeaseExpired,
  retryRecordingJob,
} = await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(jobRoot, { force: true, recursive: true });
});

test("G51: atomic transitions stop a terminal job from being clobbered", async () => {
  // A late failure report must not flip an already-completed job to failed.
  const done = recording();
  const doneJob = await createRecordingJob(done);
  await claimRecordingJob(doneJob.id, "node-a");
  assert.equal((await completeRecordingJob(done.id, doneJob.id))?.status, "completed");

  const lateFail = await failRecordingJob(doneJob.id, "late_agent_report");
  const doneAfter = (await expireRecordingJobLeases()).find((job) => job.id === doneJob.id);

  // Pre-fix failRecordingJob blind-saved failed over completed.
  assert.equal(lateFail, undefined);
  assert.equal(doneAfter?.status, "completed");

  // A late complete must not resurrect an already-failed job.
  const dead = recording();
  const deadJob = await createRecordingJob(dead);
  await claimRecordingJob(deadJob.id, "node-a");
  await failRecordingJob(deadJob.id, "capture_error");

  const resurrect = await completeRecordingJob(dead.id, deadJob.id);
  const deadAfter = (await expireRecordingJobLeases()).find((job) => job.id === deadJob.id);

  assert.equal(resurrect, undefined);
  assert.equal(deadAfter?.status, "failed");
});

test("recording jobs carry node audio command defaults", async () => {
  const job = await createRecordingJob(recording(), {
    captureBackend: "jack",
    captureChannels: 4,
    captureDevice: "system:capture_1",
    captureFormat: "S24_LE",
    captureSampleRate: 96_000,
  });

  assert.equal(job.command.captureBackend, "jack");
  assert.equal(job.command.captureChannels, 4);
  assert.equal(job.command.captureDevice, "system:capture_1");
  assert.equal(job.command.captureFormat, "S24_LE");
  assert.equal(job.command.captureSampleRate, 96_000);
});

test("recording job retry clones failed jobs and blocks active duplicates", async () => {
  const failedJob = await createRecordingJob(recording(), {
    captureDevice: "hw:Retry,0",
    durationSeconds: 120,
  });

  await failRecordingJob(failedJob.id, "capture_failed");

  const retried = await retryRecordingJob(failedJob.id);

  assert.equal(retried.ok, true);

  if (!retried.ok) {
    return;
  }

  assert.notEqual(retried.job.id, failedJob.id);
  assert.equal(retried.job.recordingId, failedJob.recordingId);
  assert.equal(retried.job.status, "queued");
  assert.deepEqual(retried.job.command, failedJob.command);

  const blocked = await retryRecordingJob(failedJob.id);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "active_job_exists");
});

test("recording job lease expiry notifies terminal listeners", async () => {
  const previousLeaseSeconds = process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS;
  process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS = "1";
  const job = await createRecordingJob(recording());
  const observed: Array<{
    jobId: string;
    reason?: string;
    terminalState: string;
  }> = [];
  const dispose = onRecordingJobLeaseExpired(({ job, terminalState }) => {
    observed.push({
      jobId: job.id,
      reason: job.failureReason,
      terminalState,
    });
  });

  try {
    const claimed = await claimRecordingJob(job.id, "node_audio_defaults");

    assert.equal(claimed?.status, "running");

    await expireRecordingJobLeases(new Date(Date.now() + 2_000));

    assert.deepEqual(observed, [
      {
        jobId: job.id,
        reason: "lease_expired",
        terminalState: "failed",
      },
    ]);
  } finally {
    dispose();

    if (previousLeaseSeconds === undefined) {
      delete process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS;
    } else {
      process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS = previousLeaseSeconds;
    }
  }
});

test("claim next recording group claims same-group siblings then a later group on its own", async () => {
  const nodeId = `node_group_${randomUUID()}`;
  const groupId = `cap_${randomUUID()}`;
  const jobA = await createRecordingJob(recording({ id: `rec_a_${randomUUID()}`, nodeId }), {
    captureChannelSelection: [1, 2],
    captureGroupId: groupId,
    captureInterfaceId: "iface_group",
  });
  const jobB = await createRecordingJob(recording({ id: `rec_b_${randomUUID()}`, nodeId }), {
    captureChannelSelection: [3, 4],
    captureGroupId: groupId,
    captureInterfaceId: "iface_group",
  });

  // With only the shared group queued, both siblings are claimed for one
  // capture session regardless of which is picked as the primary.
  const claimed = await claimNextRecordingGroup(nodeId, nodeId);

  assert.deepEqual(new Set(claimed.map((job) => job.id)), new Set([jobA.id, jobB.id]));
  assert.ok(claimed.every((job) => job.status === "running"));

  // A separate group queued afterward is claimed on its own, not pulled into the
  // first session.
  const jobOther = await createRecordingJob(recording({ id: `rec_c_${randomUUID()}`, nodeId }), {
    captureGroupId: `cap_other_${randomUUID()}`,
    captureInterfaceId: "iface_group",
  });
  const nextClaimed = await claimNextRecordingGroup(nodeId, nodeId);

  assert.deepEqual(new Set(nextClaimed.map((job) => job.id)), new Set([jobOther.id]));
});

function recording(overrides: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "tests",
    healthStatus: "unknown",
    id: `rec_audio_defaults_${randomUUID()}`,
    name: "Audio Defaults",
    nodeId: "node_audio_defaults",
    recordedAt: "2026-06-20T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: ["voice"],
    ...overrides,
  };
}
