import { randomUUID } from "node:crypto";
import type { RecordingSummary } from "@rakkr/shared";

export type RecordingJobStatus = "queued" | "running" | "stop_requested" | "completed" | "failed";

export interface RecordingJob {
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
  nodeId: string;
  recordingId: string;
  startedAt?: string;
  status: RecordingJobStatus;
  stopRequestedAt?: string;
}

export const recordingJobs: RecordingJob[] = [];

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

  return job;
}

export function nextRecordingJob(nodeId: string) {
  return recordingJobs
    .filter((job) => job.nodeId === nodeId && job.status === "queued")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}

export function claimRecordingJob(jobId: string) {
  const job = recordingJobs.find((candidate) => candidate.id === jobId);

  if (!job || job.status !== "queued") {
    return undefined;
  }

  job.startedAt = new Date().toISOString();
  job.status = "running";

  return job;
}

export function stopRecordingJob(recordingId: string) {
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

  return job;
}

export function completeRecordingJob(recordingId: string, jobId?: string) {
  const job = recordingJobs.find(
    (candidate) => candidate.recordingId === recordingId && (!jobId || candidate.id === jobId),
  );

  if (!job) {
    return undefined;
  }

  job.completedAt = new Date().toISOString();
  job.status = "completed";

  return job;
}

export function recordingJob(jobId: string) {
  return recordingJobs.find((candidate) => candidate.id === jobId);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
