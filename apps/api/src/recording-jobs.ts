import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, desc, eq, recordingJobs as recordingJobsTable } from "@rakkr/db";
import {
  defaultVoiceRecordingProfile,
  type RetentionPolicy,
  type RecordingJob,
  type RecordingJobStatus,
  type RecordingProfile,
  type RecordingSummary,
} from "@rakkr/shared";
import { findRetentionPolicy } from "./retention-policies.js";

type RecordingJobCommand = RecordingJob["command"];
type RecordingJobInsert = typeof recordingJobsTable.$inferInsert;
type RecordingJobRow = typeof recordingJobsTable.$inferSelect;
interface RecordingJobOptions {
  captureBackend?: "alsa" | "jack" | "pipewire";
  captureDevice?: string;
  captureChannels?: number;
  captureFormat?: string;
  captureInterfaceId?: string;
  captureSampleRate?: number;
  channelMap?: RecordingJobCommand["channelMap"];
  durationSeconds?: number;
  profile?: RecordingProfile;
}

interface RecordingJobStore {
  create(job: RecordingJob): Promise<void>;
  find(jobId: string): Promise<RecordingJob | undefined>;
  list(): Promise<RecordingJob[]>;
  save(job: RecordingJob): Promise<void>;
}
type RecordingJobLeaseExpirationListener = (input: {
  job: RecordingJob;
  terminalState: "cancelled" | "failed";
}) => Promise<void> | void;

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
const leaseExpirationListeners = new Set<RecordingJobLeaseExpirationListener>();

export function onRecordingJobLeaseExpired(listener: RecordingJobLeaseExpirationListener) {
  leaseExpirationListeners.add(listener);

  return () => leaseExpirationListeners.delete(listener);
}

export async function listRecordingJobs() {
  return expireRecordingJobLeases();
}

export async function createRecordingJob(
  recording: RecordingSummary,
  options: RecordingJobOptions = {},
): Promise<RecordingJob> {
  const profile = options.profile ?? defaultVoiceRecordingProfile;
  const recorderCacheRetention = await recorderCacheRetentionForRecording(recording);
  const job: RecordingJob = {
    command: {
      captureBackend: options.captureBackend,
      captureChannels:
        options.channelMap?.sourceChannels ??
        options.captureChannels ??
        positiveInteger(process.env.RAKKR_AGENT_CAPTURE_CHANNELS, 2),
      captureDevice: options.captureDevice ?? process.env.RAKKR_AGENT_CAPTURE_DEVICE ?? "default",
      captureFormat: options.captureFormat ?? process.env.RAKKR_AGENT_CAPTURE_FORMAT ?? "S16_LE",
      captureInterfaceId: options.captureInterfaceId,
      captureSampleRate:
        options.captureSampleRate ??
        positiveInteger(process.env.RAKKR_AGENT_CAPTURE_SAMPLE_RATE, 48_000),
      channelMap: options.channelMap,
      durationSeconds:
        options.durationSeconds ?? positiveInteger(process.env.RAKKR_AGENT_CAPTURE_SECONDS, 3_600),
      outputBitrateKbps: profile.bitrateKbps,
      outputCodec: profile.codec,
      outputFileName: `${recording.id}.${profile.codec}`,
      outputVbr: profile.vbr,
      recorderCacheRetention,
      trackGroupId: recording.trackGroupId,
      trackIndex: recording.trackIndex,
      trackTotal: recording.trackTotal,
      type: "alsa_capture",
    },
    createdAt: new Date().toISOString(),
    id: `job_${randomUUID()}`,
    nodeId: recording.nodeId ?? "node_x32_test",
    recordingId: recording.id,
    status: "queued",
  };

  await recordingJobStore.create(job);

  return job;
}

export async function nextRecordingJob(nodeId: string) {
  const jobs = await expireRecordingJobLeases();

  return jobs
    .filter((job) => job.nodeId === nodeId && job.status === "queued")
    .sort((left, right) => {
      const createdOrder = left.createdAt.localeCompare(right.createdAt);

      return createdOrder || trackOrder(left.command, right.command);
    })[0];
}

export async function claimRecordingJob(jobId: string, claimedBy?: string) {
  await expireRecordingJobLeases();
  const job = await recordingJobStore.find(jobId);

  if (!job || job.status !== "queued") {
    return undefined;
  }

  const now = new Date();

  job.claimedBy = claimedBy;
  job.lastHeartbeatAt = now.toISOString();
  job.leaseExpiresAt = leaseExpiry(now).toISOString();
  job.startedAt = now.toISOString();
  job.status = "running";
  await recordingJobStore.save(job);

  return job;
}

export async function claimNextRecordingJob(nodeId: string, claimedBy?: string) {
  const jobs = await expireRecordingJobLeases();
  const queuedJobs = jobs
    .filter((job) => job.nodeId === nodeId && job.status === "queued")
    .sort((left, right) => {
      const createdOrder = left.createdAt.localeCompare(right.createdAt);

      return createdOrder || trackOrder(left.command, right.command);
    });

  for (const job of queuedJobs) {
    const claimed = await claimRecordingJob(job.id, claimedBy);

    if (claimed) {
      return claimed;
    }
  }

  return undefined;
}

export async function stopRecordingJob(recordingId: string) {
  const jobs = await expireRecordingJobLeases();
  const job = jobs.find(
    (candidate) =>
      candidate.recordingId === recordingId &&
      (candidate.status === "queued" || candidate.status === "running"),
  );

  if (!job) {
    return undefined;
  }

  job.status = "stop_requested";
  job.stopRequestedAt = new Date().toISOString();
  await recordingJobStore.save(job);

  return job;
}

export async function stopRecordingJobById(jobId: string) {
  const jobs = await expireRecordingJobLeases();
  const job = jobs.find(
    (candidate) =>
      candidate.id === jobId && (candidate.status === "queued" || candidate.status === "running"),
  );

  if (!job) {
    return undefined;
  }

  job.status = "stop_requested";
  job.stopRequestedAt = new Date().toISOString();
  await recordingJobStore.save(job);

  return job;
}

export async function retryRecordingJob(jobId: string) {
  const jobs = await expireRecordingJobLeases();
  const job = jobs.find((candidate) => candidate.id === jobId);

  if (!job) {
    return {
      ok: false as const,
      reason: "job_not_found",
    };
  }

  if (job.status !== "failed" && job.status !== "cancelled") {
    return {
      job,
      ok: false as const,
      reason: "job_not_retryable",
    };
  }

  const activeJob = jobs.find(
    (candidate) =>
      candidate.recordingId === job.recordingId &&
      candidate.id !== job.id &&
      (candidate.status === "queued" ||
        candidate.status === "running" ||
        candidate.status === "stop_requested"),
  );

  if (activeJob) {
    return {
      activeJob,
      job,
      ok: false as const,
      reason: "active_job_exists",
    };
  }

  const retryJob: RecordingJob = {
    command: structuredClone(job.command),
    createdAt: new Date().toISOString(),
    id: `job_${randomUUID()}`,
    nodeId: job.nodeId,
    recordingId: job.recordingId,
    status: "queued",
  };

  await recordingJobStore.create(retryJob);

  return {
    job: retryJob,
    ok: true as const,
    sourceJob: job,
  };
}

export async function completeRecordingJob(recordingId: string, jobId?: string) {
  const jobs = await expireRecordingJobLeases();
  const job = jobs.find(
    (candidate) => candidate.recordingId === recordingId && (!jobId || candidate.id === jobId),
  );

  if (!job) {
    return undefined;
  }

  job.completedAt = new Date().toISOString();
  job.status = "completed";
  await recordingJobStore.save(job);

  return job;
}

export async function cancelRecordingJob(jobId: string, reason?: string) {
  const job = await recordingJobStore.find(jobId);

  if (!job) {
    return undefined;
  }

  job.completedAt = new Date().toISOString();
  job.failureReason = reason;
  job.status = "cancelled";
  await recordingJobStore.save(job);

  return job;
}

export async function failRecordingJob(jobId: string, reason?: string) {
  const job = await recordingJobStore.find(jobId);

  if (!job) {
    return undefined;
  }

  job.completedAt = new Date().toISOString();
  job.failureReason = reason;
  job.status = "failed";
  await recordingJobStore.save(job);

  return job;
}

export async function recordingJob(jobId: string) {
  await expireRecordingJobLeases();

  return recordingJobStore.find(jobId);
}

export async function heartbeatRecordingJob(jobId: string, claimedBy?: string) {
  await expireRecordingJobLeases();
  const job = await recordingJobStore.find(jobId);

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
  await recordingJobStore.save(job);

  return job;
}

export async function expireRecordingJobLeases(now = new Date()) {
  const jobs = await recordingJobStore.list();
  const expiredAt = now.toISOString();
  const changedJobs: RecordingJob[] = [];

  for (const job of jobs) {
    if (job.status === "running" && isExpired(job, now)) {
      job.completedAt = expiredAt;
      job.failureReason = "lease_expired";
      job.status = "failed";
      changedJobs.push(job);
    }

    if (job.status === "stop_requested" && isStopRequestExpired(job, now)) {
      job.completedAt = expiredAt;
      job.failureReason = "stop_request_lease_expired";
      job.status = "cancelled";
      changedJobs.push(job);
    }
  }

  await Promise.all(changedJobs.map((job) => recordingJobStore.save(job)));
  await Promise.all(
    changedJobs.map(async (job) => {
      const terminalState = job.status === "cancelled" ? "cancelled" : "failed";

      await notifyLeaseExpirationListeners(job, terminalState);
    }),
  );

  return jobs;
}

async function notifyLeaseExpirationListeners(
  job: RecordingJob,
  terminalState: "cancelled" | "failed",
) {
  await Promise.all(
    Array.from(leaseExpirationListeners).map(async (listener) => {
      try {
        await listener({ job, terminalState });
      } catch (error) {
        console.warn("recording job lease expiration listener failed", error);
      }
    }),
  );
}

class JsonRecordingJobStore implements RecordingJobStore {
  private readonly jobs: RecordingJob[] = loadRecordingJobs();

  async create(job: RecordingJob) {
    this.jobs.unshift(job);
    this.persist();
  }

  async find(jobId: string) {
    return this.jobs.find((candidate) => candidate.id === jobId);
  }

  async list() {
    return this.jobs;
  }

  async save(job: RecordingJob) {
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id);

    if (index >= 0) {
      this.jobs[index] = job;
    } else {
      this.jobs.unshift(job);
    }

    this.persist();
  }

  private persist() {
    mkdirSync(path.dirname(jobStorePath), { recursive: true });
    const tempPath = `${jobStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        jobs: this.jobs,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, jobStorePath);
  }
}

class PostgresRecordingJobStore implements RecordingJobStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: RecordingJobStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async create(job: RecordingJob) {
    if (!this.dbAvailable) {
      await this.fallback.create(job);
      return;
    }

    try {
      await this.write(job);
    } catch (error) {
      await this.failover("recording job persistence unavailable; using JSON store", error);
      await this.fallback.create(job);
    }
  }

  async find(jobId: string) {
    if (!this.dbAvailable) {
      return this.fallback.find(jobId);
    }

    try {
      const [row] = await this.db
        .select()
        .from(recordingJobsTable)
        .where(eq(recordingJobsTable.id, jobId))
        .limit(1);

      return row ? recordingJobFromRow(row) : undefined;
    } catch (error) {
      await this.failover("recording job lookup unavailable; using JSON store", error);
      return this.fallback.find(jobId);
    }
  }

  async list() {
    if (!this.dbAvailable) {
      return this.fallback.list();
    }

    try {
      const rows = await this.db
        .select()
        .from(recordingJobsTable)
        .orderBy(desc(recordingJobsTable.createdAt));

      return rows.map(recordingJobFromRow);
    } catch (error) {
      await this.failover("recording job query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async save(job: RecordingJob) {
    if (!this.dbAvailable) {
      await this.fallback.save(job);
      return;
    }

    try {
      await this.write(job);
    } catch (error) {
      await this.failover("recording job update unavailable; using JSON store", error);
      await this.fallback.save(job);
    }
  }

  private async failover(message: string, error: unknown) {
    this.dbAvailable = false;
    console.warn(message, error);
  }

  private async write(job: RecordingJob) {
    const row = recordingJobToRow(job);

    await this.db
      .insert(recordingJobsTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
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
        },
        target: recordingJobsTable.id,
      });
  }
}

function createRecordingJobStore(): RecordingJobStore {
  const fallback = new JsonRecordingJobStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresRecordingJobStore(databaseUrl, fallback) : fallback;
}

const recordingJobStore = createRecordingJobStore();

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

function recordingJobToRow(job: RecordingJob): RecordingJobInsert {
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

function recordingJobFromRow(row: RecordingJobRow): RecordingJob {
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

function commandFromValue(value: unknown): RecordingJobCommand {
  if (!isRecord(value) || value.type !== "alsa_capture") {
    throw new Error("recording_job_command_invalid");
  }

  return {
    captureChannels: positiveIntegerFromUnknown(value.captureChannels, 2),
    captureBackend: captureBackendFromUnknown(value.captureBackend),
    captureDevice: stringFromUnknown(value.captureDevice, "default"),
    captureFormat: stringFromUnknown(value.captureFormat, "S16_LE"),
    captureInterfaceId: stringOrUndefined(value.captureInterfaceId),
    captureSampleRate: positiveIntegerFromUnknown(value.captureSampleRate, 48_000),
    channelMap: channelMapFromValue(value.channelMap),
    durationSeconds: positiveIntegerFromUnknown(value.durationSeconds, 3_600),
    outputBitrateKbps: optionalPositiveInteger(value.outputBitrateKbps),
    outputCodec: outputCodecFromUnknown(value.outputCodec),
    outputFileName: stringFromUnknown(value.outputFileName, "recording.wav"),
    outputVbr: typeof value.outputVbr === "boolean" ? value.outputVbr : undefined,
    recorderCacheRetention: recorderCacheRetentionFromValue(value.recorderCacheRetention),
    trackGroupId: stringOrUndefined(value.trackGroupId),
    trackIndex: optionalPositiveInteger(value.trackIndex),
    trackTotal: optionalPositiveInteger(value.trackTotal),
    type: "alsa_capture",
  };
}

function dateOrNull(value: string | undefined) {
  return value ? new Date(value) : null;
}

function isoOrUndefined(value: Date | null) {
  return value?.toISOString();
}

function positiveIntegerFromUnknown(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringFromUnknown(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function channelMapFromValue(value: unknown): RecordingJobCommand["channelMap"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceChannels = positiveIntegerFromUnknown(value.sourceChannels, 0);

  if (sourceChannels <= 0) {
    return undefined;
  }

  return {
    assignmentId: stringFromUnknown(value.assignmentId, "unknown_assignment"),
    channelMode: channelModeFromUnknown(value.channelMode),
    entries: channelMapEntriesFromValue(value.entries, sourceChannels),
    sourceChannels,
    targetId: stringFromUnknown(value.targetId, "unknown_target"),
    targetType: value.targetType === "interface" ? "interface" : "node",
    templateId: stringFromUnknown(value.templateId, "unknown_template"),
    templateName: stringFromUnknown(value.templateName, "Unknown Template"),
  };
}

function channelMapEntriesFromValue(value: unknown, sourceChannels: number) {
  if (!Array.isArray(value)) {
    return Array.from({ length: sourceChannels }, (_, index) => ({
      included: true,
      label: `Channel ${index + 1}`,
      outputChannelIndex: index + 1,
      sourceChannelIndex: index + 1,
    }));
  }

  return value.filter(isRecord).map((entry) => ({
    included: entry.included === true,
    label: stringFromUnknown(
      entry.label,
      `Channel ${positiveIntegerFromUnknown(entry.sourceChannelIndex, 1)}`,
    ),
    outputChannelIndex:
      typeof entry.outputChannelIndex === "number" && Number.isInteger(entry.outputChannelIndex)
        ? entry.outputChannelIndex
        : undefined,
    sourceChannelIndex: positiveIntegerFromUnknown(entry.sourceChannelIndex, 1),
  }));
}

function channelModeFromUnknown(
  value: unknown,
): NonNullable<RecordingJobCommand["channelMap"]>["channelMode"] {
  return value === "mono" ||
    value === "stereo" ||
    value === "mono_to_stereo_mix" ||
    value === "multichannel"
    ? value
    : "mono_to_stereo_mix";
}

function outputCodecFromUnknown(value: unknown): RecordingJobCommand["outputCodec"] {
  return value === "mp3" || value === "flac" || value === "wav" ? value : undefined;
}

function recorderCacheRetentionFromValue(
  value: unknown,
): RecordingJobCommand["recorderCacheRetention"] {
  if (!isRecord(value)) {
    return undefined;
  }

  const policyId = stringOrUndefined(value.policyId);

  if (!policyId || typeof value.deleteAfterUpload !== "boolean") {
    return undefined;
  }

  return {
    deleteAfterUpload: value.deleteAfterUpload,
    policyId,
  };
}

function trackOrder(left: RecordingJobCommand, right: RecordingJobCommand) {
  if (left.trackGroupId && left.trackGroupId === right.trackGroupId) {
    return (left.trackIndex ?? 0) - (right.trackIndex ?? 0);
  }

  return 0;
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

function captureBackendFromUnknown(value: unknown): RecordingJobCommand["captureBackend"] {
  return value === "pipewire"
    ? "pipewire"
    : value === "jack"
      ? "jack"
      : value === "alsa"
        ? "alsa"
        : undefined;
}

function optionalCaptureBackend(value: unknown) {
  return value === undefined || value === "alsa" || value === "jack" || value === "pipewire";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function recorderCacheRetentionForRecording(
  recording: RecordingSummary,
): Promise<RecordingJobCommand["recorderCacheRetention"]> {
  const policy = await findRetentionPolicy(recording.retentionPolicyId);

  if (!isExecutableRecorderCachePolicy(policy)) {
    return undefined;
  }

  return {
    deleteAfterUpload: !hasDeferredRecorderCacheLimits(policy),
    maxAgeDays: policy.maxAgeDays,
    maxBytes: policy.maxBytes,
    minFreeDiskPercent: policy.minFreeDiskPercent,
    policyId: policy.id,
  };
}

function isExecutableRecorderCachePolicy(
  policy: RetentionPolicy | undefined,
): policy is RetentionPolicy {
  return Boolean(
    policy?.enabled && policy.scope === "recorder_cache" && policy.action === "delete_cache",
  );
}

function hasDeferredRecorderCacheLimits(policy: RetentionPolicy) {
  return (
    policy.maxAgeDays !== null || policy.maxBytes !== null || policy.minFreeDiskPercent !== null
  );
}
