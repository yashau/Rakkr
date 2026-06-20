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

const { createRecordingJob, failRecordingJob, retryRecordingJob } =
  await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(jobRoot, { force: true, recursive: true });
});

test("recording jobs carry node audio command defaults", async () => {
  const job = await createRecordingJob(recording(), {
    captureBackend: "pipewire",
    captureChannels: 4,
    captureDevice: "hw:Loopback,1,0",
    captureFormat: "S24_LE",
    captureSampleRate: 96_000,
  });

  assert.equal(job.command.captureBackend, "pipewire");
  assert.equal(job.command.captureChannels, 4);
  assert.equal(job.command.captureDevice, "hw:Loopback,1,0");
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

function recording(): RecordingSummary {
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
  };
}
