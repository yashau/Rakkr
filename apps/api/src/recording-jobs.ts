import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  and,
  createDatabase,
  desc,
  eq,
  inArray,
  recordingJobs as recordingJobsTable,
} from "@rakkr/db";
import { DatabaseUnavailableError } from "./database-unavailable.js";
import {
  defaultVoiceRecordingProfile,
  effectiveChunkSeconds,
  type RetentionPolicy,
  type RecordingJob,
  type RecordingJobStatus,
  type RecordingProfile,
  type RecordingSummary,
} from "@rakkr/shared";
import { commandFromValue } from "./recording-job-command.js";
import { findRetentionPolicy } from "./retention-policies.js";

type RecordingJobCommand = RecordingJob["command"];
type RecordingJobInsert = typeof recordingJobsTable.$inferInsert;
type RecordingJobRow = typeof recordingJobsTable.$inferSelect;
interface RecordingJobOptions {
  captureBackend?: "alsa" | "jack" | "pipewire";
  captureChannelSelection?: number[];
  captureDevice?: string;
  captureChannels?: number;
  captureFormat?: string;
  captureGroupId?: string;
  captureInterfaceId?: string;
  captureSampleRate?: number;
  channelMap?: RecordingJobCommand["channelMap"];
  chunkSeconds?: number;
  durationSeconds?: number;
  profile?: RecordingProfile;
}

interface RecordingJobStore {
  // Atomic compare-and-set: persist `job` only if the stored row is still in
  // `expectedStatus`, returning the job when it won the claim and `undefined`
  // when another claimer already moved it. This is the guard against two agents
  // claiming (and capturing) the same job — a plain find-then-save races.
  claim(
    job: RecordingJob,
    expectedStatus: RecordingJob["status"],
  ): Promise<RecordingJob | undefined>;
  // Atomic compare-and-set for lifecycle transitions: persist `job` only if the
  // stored row's status is still one of `allowedFrom`, returning the job on a
  // win and `undefined` when another writer already moved it. This is what stops
  // a late/racing transition (e.g. a stale complete) from clobbering a terminal
  // state — a plain find-then-save is a blind last-writer-wins.
  transition(
    job: RecordingJob,
    allowedFrom: RecordingJobStatus[],
  ): Promise<RecordingJob | undefined>;
  create(job: RecordingJob): Promise<void>;
  deleteForRecording(recordingId: string): Promise<void>;
  find(jobId: string): Promise<RecordingJob | undefined>;
  list(): Promise<RecordingJob[]>;
  save(job: RecordingJob): Promise<void>;
}
// Statuses a job may still be transitioned *out of* to a terminal/stop state.
const NON_TERMINAL_SOURCES: RecordingJobStatus[] = ["queued", "running", "stop_requested"];
const STOPPABLE_SOURCES: RecordingJobStatus[] = ["queued", "running"];
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
      captureChannelSelection:
        options.captureChannelSelection && options.captureChannelSelection.length > 0
          ? options.captureChannelSelection
          : undefined,
      captureDevice: options.captureDevice ?? process.env.RAKKR_AGENT_CAPTURE_DEVICE ?? "default",
      captureFormat: options.captureFormat ?? process.env.RAKKR_AGENT_CAPTURE_FORMAT ?? "S16_LE",
      captureGroupId: options.captureGroupId,
      captureInterfaceId: options.captureInterfaceId,
      captureSampleRate:
        options.captureSampleRate ??
        positiveInteger(process.env.RAKKR_AGENT_CAPTURE_SAMPLE_RATE, 48_000),
      channelMap: options.channelMap,
      chunkSeconds: options.chunkSeconds ?? effectiveChunkSeconds(profile),
      durationSeconds:
        options.durationSeconds ?? positiveInteger(process.env.RAKKR_AGENT_CAPTURE_SECONDS, 3_600),
      enhancement: profile.enhancement,
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
  const claimed: RecordingJob = {
    ...job,
    claimedBy,
    lastHeartbeatAt: now.toISOString(),
    leaseExpiresAt: leaseExpiry(now).toISOString(),
    startedAt: now.toISOString(),
    status: "running",
  };

  // Atomic compare-and-set on `queued`. If a concurrent claim already flipped
  // the job to `running`, this returns undefined and the caller backs off —
  // exactly one claimer wins, so a job (or capture group) is never captured
  // twice.
  return recordingJobStore.claim(claimed, "queued");
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

// Claims the next queued job plus every queued sibling that shares its
// captureGroupId, so the agent can capture the device once and split it into
// each job's channel subset. Jobs without a group claim alone (legacy behavior).
export async function claimNextRecordingGroup(
  nodeId: string,
  claimedBy?: string,
): Promise<RecordingJob[]> {
  const jobs = await expireRecordingJobLeases();
  const queued = jobs
    .filter((job) => job.nodeId === nodeId && job.status === "queued")
    .sort((left, right) => {
      const createdOrder = left.createdAt.localeCompare(right.createdAt);

      return createdOrder || trackOrder(left.command, right.command);
    });

  const primary = queued[0];

  if (!primary) {
    return [];
  }

  const groupId = primary.command.captureGroupId;
  const members = groupId
    ? queued.filter((job) => job.command.captureGroupId === groupId)
    : [primary];
  const claimed: RecordingJob[] = [];

  for (const member of members) {
    const job = await claimRecordingJob(member.id, claimedBy);

    if (job) {
      claimed.push(job);
    }
  }

  return claimed;
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

  return recordingJobStore.transition(
    { ...job, status: "stop_requested", stopRequestedAt: new Date().toISOString() },
    STOPPABLE_SOURCES,
  );
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

  return recordingJobStore.transition(
    { ...job, status: "stop_requested", stopRequestedAt: new Date().toISOString() },
    STOPPABLE_SOURCES,
  );
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

  // A duplicate upload for an already-completed job is an idempotent no-op.
  if (job.status === "completed") {
    return job;
  }

  // Atomic: only complete from a non-terminal state, so a late/racing upload
  // cannot resurrect a job the controller already failed/cancelled.
  return recordingJobStore.transition(
    { ...job, completedAt: new Date().toISOString(), status: "completed" },
    NON_TERMINAL_SOURCES,
  );
}

export async function cancelRecordingJob(jobId: string, reason?: string) {
  const job = await recordingJobStore.find(jobId);

  if (!job) {
    return undefined;
  }

  if (job.status === "cancelled") {
    return job;
  }

  return recordingJobStore.transition(
    { ...job, completedAt: new Date().toISOString(), failureReason: reason, status: "cancelled" },
    NON_TERMINAL_SOURCES,
  );
}

export async function failRecordingJob(jobId: string, reason?: string) {
  const job = await recordingJobStore.find(jobId);

  if (!job) {
    return undefined;
  }

  if (job.status === "failed") {
    return job;
  }

  return recordingJobStore.transition(
    { ...job, completedAt: new Date().toISOString(), failureReason: reason, status: "failed" },
    NON_TERMINAL_SOURCES,
  );
}

export async function recordingJob(jobId: string) {
  await expireRecordingJobLeases();

  return recordingJobStore.find(jobId);
}

// Remove every job row for a recording (used when the recording is deleted —
// recording_jobs has no FK cascade, so the rows would otherwise outlive it).
export async function deleteRecordingJobsForRecording(recordingId: string) {
  await recordingJobStore.deleteForRecording(recordingId);
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
  const expired: Array<{ job: RecordingJob; terminalState: "cancelled" | "failed" }> = [];

  for (const job of jobs) {
    // Expire through the atomic CAS, not a blind save: only transition a job that
    // is STILL in its expected source status. Otherwise a reaper pass built from a
    // stale snapshot could revert a job a concurrent complete/fail/cancel already
    // moved (e.g. clobbering a freshly-`completed` job back to `failed`).
    if (job.status === "running" && isExpired(job, now)) {
      const changed = await recordingJobStore.transition(
        { ...job, completedAt: expiredAt, failureReason: "lease_expired", status: "failed" },
        ["running"],
      );

      if (changed) {
        expired.push({ job: changed, terminalState: "failed" });
      }
    } else if (job.status === "stop_requested" && isStopRequestExpired(job, now)) {
      const changed = await recordingJobStore.transition(
        {
          ...job,
          completedAt: expiredAt,
          failureReason: "stop_request_lease_expired",
          status: "cancelled",
        },
        ["stop_requested"],
      );

      if (changed) {
        expired.push({ job: changed, terminalState: "cancelled" });
      }
    }
  }

  await Promise.all(
    expired.map(({ job, terminalState }) => notifyLeaseExpirationListeners(job, terminalState)),
  );

  // Return the post-expiry truth so callers that immediately `.find()` a job see
  // its transitioned state, not the pre-expiry snapshot we iterated.
  return expired.length > 0 ? recordingJobStore.list() : jobs;
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

  async claim(job: RecordingJob, expectedStatus: RecordingJob["status"]) {
    // No `await` between the read and the write, so within the single-threaded
    // event loop this check-and-set is atomic — a second interleaved claim sees
    // the already-updated status and loses.
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id);

    if (index < 0 || this.jobs[index]?.status !== expectedStatus) {
      return undefined;
    }

    this.jobs[index] = job;
    this.persist();

    return job;
  }

  async transition(job: RecordingJob, allowedFrom: RecordingJobStatus[]) {
    // Atomic within the single-threaded event loop (no await between the read
    // and the write): a concurrent transition that already moved the job sees
    // its new status and loses.
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id);
    const current = this.jobs[index];

    if (!current || !allowedFrom.includes(current.status)) {
      return undefined;
    }

    this.jobs[index] = job;
    this.persist();

    return job;
  }

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

  async deleteForRecording(recordingId: string) {
    let removed = false;

    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      if (this.jobs[index]?.recordingId === recordingId) {
        this.jobs.splice(index, 1);
        removed = true;
      }
    }

    if (removed) {
      this.persist();
    }
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

  async claim(job: RecordingJob, expectedStatus: RecordingJob["status"]) {
    if (!this.dbAvailable) {
      return this.fallback.claim(job, expectedStatus);
    }

    try {
      const row = recordingJobToRow(job);
      // Single atomic statement: transition only if the row is still in the
      // expected status. `returning()` yields zero rows when another claimer
      // already won, so no read-modify-write window exists.
      const [updated] = await this.db
        .update(recordingJobsTable)
        .set({
          claimedBy: row.claimedBy,
          lastHeartbeatAt: row.lastHeartbeatAt,
          leaseExpiresAt: row.leaseExpiresAt,
          startedAt: row.startedAt,
          status: row.status,
          updatedAt: new Date(),
        })
        .where(
          and(eq(recordingJobsTable.id, job.id), eq(recordingJobsTable.status, expectedStatus)),
        )
        .returning();

      return updated ? recordingJobFromRow(updated) : undefined;
    } catch (error) {
      await this.failover("recording job claim unavailable; using JSON store", error);
      return this.fallback.claim(job, expectedStatus);
    }
  }

  async transition(job: RecordingJob, allowedFrom: RecordingJobStatus[]) {
    if (!this.dbAvailable) {
      return this.fallback.transition(job, allowedFrom);
    }

    try {
      const row = recordingJobToRow(job);
      // Single atomic statement: apply the full transition only if the row is
      // still in an allowed source status; zero returned rows means another
      // writer already moved it, so we report the lost CAS as `undefined`.
      const [updated] = await this.db
        .update(recordingJobsTable)
        .set(recordingJobMutableColumns(row))
        .where(
          and(eq(recordingJobsTable.id, job.id), inArray(recordingJobsTable.status, allowedFrom)),
        )
        .returning();

      return updated ? recordingJobFromRow(updated) : undefined;
    } catch (error) {
      await this.failover("recording job transition unavailable; using JSON store", error);
      return this.fallback.transition(job, allowedFrom);
    }
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

  async deleteForRecording(recordingId: string) {
    if (!this.dbAvailable) {
      await this.fallback.deleteForRecording(recordingId);
      return;
    }

    try {
      await this.db
        .delete(recordingJobsTable)
        .where(eq(recordingJobsTable.recordingId, recordingId));
    } catch (error) {
      await this.failover("recording job delete unavailable; using JSON store", error);
      await this.fallback.deleteForRecording(recordingId);
    }
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }

  private async write(job: RecordingJob) {
    const row = recordingJobToRow(job);

    await this.db
      .insert(recordingJobsTable)
      .values(row)
      .onConflictDoUpdate({
        set: recordingJobMutableColumns(row),
        target: recordingJobsTable.id,
      });
  }
}

// The mutable column set shared by the unconditional upsert (`write`) and the
// conditional compare-and-set (`transition`), so both stay in lockstep.
function recordingJobMutableColumns(row: RecordingJobInsert) {
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

function dateOrNull(value: string | undefined) {
  return value ? new Date(value) : null;
}

function isoOrUndefined(value: Date | null) {
  return value?.toISOString();
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
