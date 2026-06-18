import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RecordingSummary } from "@rakkr/shared";

export type RecordingJobStatus =
  | "queued"
  | "running"
  | "stop_requested"
  | "cancelled"
  | "completed"
  | "failed";

export interface RecordingJob {
  claimedBy?: string;
  command: {
    captureChannels: number;
    captureDevice: string;
    captureFormat: string;
    captureSampleRate: number;
    durationSeconds: number;
    outputFileName: string;
    type: "alsa_capture";
  };
  completedAt?: string;
  createdAt: string;
  id: string;
  failureReason?: string;
  nodeId: string;
  lastHeartbeatAt?: string;
  leaseExpiresAt?: string;
  recordingId: string;
  startedAt?: string;
  status: RecordingJobStatus;
  stopRequestedAt?: string;
}

const jobStorePath = path.resolve(
  process.env.RAKKR_RECORDING_JOB_STORE_PATH ?? "data/recording-jobs.json",
);
const recordingJobStatuses = new Set<RecordingJobStatus>([
  "queued",
  "running",
  "stop_requested",
  "cancelled",
  "completed",
  "failed",
]);

export const recordingJobs: RecordingJob[] = loadRecordingJobs();

export function listRecordingJobs() {
  expireRecordingJobLeases();

  return recordingJobs;
}

export function createRecordingJob(recording: RecordingSummary): RecordingJob {
  const job: RecordingJob = {
    command: {
      captureChannels: positiveInteger(process.env.RAKKR_AGENT_CAPTURE_CHANNELS, 2),
      captureDevice: process.env.RAKKR_AGENT_CAPTURE_DEVICE ?? "default",
      captureFormat: process.env.RAKKR_AGENT_CAPTURE_FORMAT ?? "S16_LE",
      captureSampleRate: positiveInteger(process.env.RAKKR_AGENT_CAPTURE_SAMPLE_RATE, 48_000),
      durationSeconds: positiveInteger(process.env.RAKKR_AGENT_CAPTURE_SECONDS, 3_600),
      outputFileName: `${recording.id}.wav`,
      type: "alsa_capture",
    },
    createdAt: new Date().toISOString(),
    id: `job_${randomUUID()}`,
    nodeId: recording.nodeId ?? "node_x32_test",
    recordingId: recording.id,
    status: "queued",
  };

  recordingJobs.unshift(job);
  persistRecordingJobs();

  return job;
}

export function nextRecordingJob(nodeId: string) {
  expireRecordingJobLeases();

  return recordingJobs
    .filter((job) => job.nodeId === nodeId && job.status === "queued")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}

export function claimRecordingJob(jobId: string, claimedBy?: string) {
  expireRecordingJobLeases();
  const job = recordingJobs.find((candidate) => candidate.id === jobId);

  if (!job || job.status !== "queued") {
    return undefined;
  }

  const now = new Date();

  job.claimedBy = claimedBy;
  job.lastHeartbeatAt = now.toISOString();
  job.leaseExpiresAt = leaseExpiry(now).toISOString();
  job.startedAt = now.toISOString();
  job.status = "running";
  persistRecordingJobs();

  return job;
}

export function stopRecordingJob(recordingId: string) {
  expireRecordingJobLeases();
  const job = recordingJobs.find(
    (candidate) =>
      candidate.recordingId === recordingId &&
      (candidate.status === "queued" || candidate.status === "running"),
  );

  if (!job) {
    return undefined;
  }

  job.status = "stop_requested";
  job.stopRequestedAt = new Date().toISOString();
  persistRecordingJobs();

  return job;
}

export function completeRecordingJob(recordingId: string, jobId?: string) {
  expireRecordingJobLeases();
  const job = recordingJobs.find(
    (candidate) => candidate.recordingId === recordingId && (!jobId || candidate.id === jobId),
  );

  if (!job) {
    return undefined;
  }

  job.completedAt = new Date().toISOString();
  job.status = "completed";
  persistRecordingJobs();

  return job;
}

export function cancelRecordingJob(jobId: string, reason?: string) {
  const job = recordingJobs.find((candidate) => candidate.id === jobId);

  if (!job) {
    return undefined;
  }

  job.completedAt = new Date().toISOString();
  job.failureReason = reason;
  job.status = "cancelled";
  persistRecordingJobs();

  return job;
}

export function failRecordingJob(jobId: string, reason?: string) {
  const job = recordingJobs.find((candidate) => candidate.id === jobId);

  if (!job) {
    return undefined;
  }

  job.completedAt = new Date().toISOString();
  job.failureReason = reason;
  job.status = "failed";
  persistRecordingJobs();

  return job;
}

export function recordingJob(jobId: string) {
  expireRecordingJobLeases();

  return recordingJobs.find((candidate) => candidate.id === jobId);
}

export function heartbeatRecordingJob(jobId: string, claimedBy?: string) {
  expireRecordingJobLeases();
  const job = recordingJobs.find((candidate) => candidate.id === jobId);

  if (!job || job.status !== "running") {
    return undefined;
  }

  if (claimedBy && job.claimedBy && claimedBy !== job.claimedBy) {
    return undefined;
  }

  const now = new Date();

  job.claimedBy = claimedBy ?? job.claimedBy;
  job.lastHeartbeatAt = now.toISOString();
  job.leaseExpiresAt = leaseExpiry(now).toISOString();
  persistRecordingJobs();

  return job;
}

export function expireRecordingJobLeases(now = new Date()) {
  const expiredAt = now.toISOString();
  let changed = false;

  for (const job of recordingJobs) {
    if (job.status === "running" && isExpired(job, now)) {
      job.completedAt = expiredAt;
      job.failureReason = "lease_expired";
      job.status = "failed";
      changed = true;
    }

    if (job.status === "stop_requested" && isStopRequestExpired(job, now)) {
      job.completedAt = expiredAt;
      job.failureReason = "stop_request_lease_expired";
      job.status = "cancelled";
      changed = true;
    }
  }

  if (changed) {
    persistRecordingJobs();
  }

  return recordingJobs;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function leaseSeconds() {
  return positiveInteger(process.env.RAKKR_RECORDING_JOB_LEASE_SECONDS, 30);
}

function leaseExpiry(now: Date) {
  return new Date(now.getTime() + leaseSeconds() * 1000);
}

function isExpired(job: RecordingJob, now: Date) {
  const leaseAnchor = job.leaseExpiresAt
    ? Date.parse(job.leaseExpiresAt)
    : Date.parse(job.lastHeartbeatAt ?? job.startedAt ?? job.createdAt) + leaseSeconds() * 1000;

  return Number.isFinite(leaseAnchor) && leaseAnchor <= now.getTime();
}

function isStopRequestExpired(job: RecordingJob, now: Date) {
  if (!job.stopRequestedAt) {
    return false;
  }

  const expiresAt = Date.parse(job.stopRequestedAt) + leaseSeconds() * 1000;

  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function loadRecordingJobs(): RecordingJob[] {
  if (!existsSync(jobStorePath)) {
    return [];
  }

  const raw = readFileSync(jobStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const jobs = isRecordingJobStore(parsed) ? parsed.jobs : parsed;

  if (!Array.isArray(jobs)) {
    throw new Error("recording_job_store_invalid");
  }

  return jobs.filter(isRecordingJob);
}

function persistRecordingJobs() {
  mkdirSync(path.dirname(jobStorePath), { recursive: true });
  const tempPath = `${jobStorePath}.${process.pid}.tmp`;
  const payload = JSON.stringify(
    {
      jobs: recordingJobs,
      updatedAt: new Date().toISOString(),
      version: 1,
    },
    null,
    2,
  );

  writeFileSync(tempPath, `${payload}\n`);
  renameSync(tempPath, jobStorePath);
}

function isRecordingJobStore(value: unknown): value is { jobs: unknown[] } {
  return isRecord(value) && Array.isArray(value.jobs);
}

function isRecordingJob(value: unknown): value is RecordingJob {
  if (!isRecord(value) || !isRecord(value.command)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.recordingId === "string" &&
    recordingJobStatuses.has(value.status as RecordingJobStatus) &&
    typeof value.command.captureChannels === "number" &&
    typeof value.command.captureDevice === "string" &&
    typeof value.command.captureFormat === "string" &&
    typeof value.command.captureSampleRate === "number" &&
    typeof value.command.durationSeconds === "number" &&
    typeof value.command.outputFileName === "string" &&
    value.command.type === "alsa_capture"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
