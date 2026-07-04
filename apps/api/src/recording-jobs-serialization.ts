import { existsSync, readFileSync } from "node:fs";
import { recordingJobs as recordingJobsTable } from "@rakkr/db";
import type { RecordingJob, RecordingJobStatus } from "@rakkr/shared";
import { commandFromValue } from "./recording-job-command.js";

// Serialization layer for recording jobs: the pure mappers between the
// RecordingJob model and its persisted representations (the Postgres row and
// the JSON store blob), plus the JSON-store load/validation. Extracted from
// recording-jobs.ts to keep that module under the 1000-LOC budget; nothing here
// touches lifecycle/lease state, so it moves verbatim.
type RecordingJobInsert = typeof recordingJobsTable.$inferInsert;
type RecordingJobRow = typeof recordingJobsTable.$inferSelect;

const recordingJobStatuses = new Set<RecordingJobStatus>([
  "queued",
  "running",
  "stop_requested",
  "cancelled",
  "completed",
  "failed",
]);

// The mutable column set shared by the unconditional upsert (`write`) and the
// conditional compare-and-set (`transition`), so both stay in lockstep.
export function recordingJobMutableColumns(row: RecordingJobInsert) {
  return {
    claimedBy: row.claimedBy,
    command: row.command,
    completedAt: row.completedAt,
    failureReason: row.failureReason,
    lastHeartbeatAt: row.lastHeartbeatAt,
    leaseExpiresAt: row.leaseExpiresAt,
    nodeId: row.nodeId,
    recordingId: row.recordingId,
    startedAt: row.startedAt,
    status: row.status,
    stopRequestedAt: row.stopRequestedAt,
    updatedAt: new Date(),
  };
}

export function recordingJobToRow(job: RecordingJob): RecordingJobInsert {
  return {
    claimedBy: job.claimedBy ?? null,
    command: job.command,
    completedAt: dateOrNull(job.completedAt),
    createdAt: new Date(job.createdAt),
    failureReason: job.failureReason ?? null,
    id: job.id,
    lastHeartbeatAt: dateOrNull(job.lastHeartbeatAt),
    leaseExpiresAt: dateOrNull(job.leaseExpiresAt),
    nodeId: job.nodeId,
    recordingId: job.recordingId,
    startedAt: dateOrNull(job.startedAt),
    status: job.status,
    stopRequestedAt: dateOrNull(job.stopRequestedAt),
    updatedAt: new Date(),
  };
}

export function recordingJobFromRow(row: RecordingJobRow): RecordingJob {
  return {
    claimedBy: row.claimedBy ?? undefined,
    command: commandFromValue(row.command),
    completedAt: isoOrUndefined(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    failureReason: row.failureReason ?? undefined,
    id: row.id,
    lastHeartbeatAt: isoOrUndefined(row.lastHeartbeatAt),
    leaseExpiresAt: isoOrUndefined(row.leaseExpiresAt),
    nodeId: row.nodeId,
    recordingId: row.recordingId,
    startedAt: isoOrUndefined(row.startedAt),
    status: row.status,
    stopRequestedAt: isoOrUndefined(row.stopRequestedAt),
  };
}

export function loadRecordingJobs(jobStorePath: string): RecordingJob[] {
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

function dateOrNull(value: string | undefined) {
  return value ? new Date(value) : null;
}

function isoOrUndefined(value: Date | null) {
  return value?.toISOString();
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
    optionalCaptureBackend(value.command.captureBackend) &&
    typeof value.command.captureDevice === "string" &&
    typeof value.command.captureFormat === "string" &&
    typeof value.command.captureSampleRate === "number" &&
    typeof value.command.durationSeconds === "number" &&
    typeof value.command.outputFileName === "string" &&
    value.command.type === "alsa_capture"
  );
}

function optionalCaptureBackend(value: unknown) {
  return value === undefined || value === "alsa" || value === "jack" || value === "pipewire";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
