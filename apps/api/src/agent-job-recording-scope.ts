import type { RecordingJob, RecordingSummary } from "@rakkr/shared";

import type { AuditTarget } from "./http-types.js";
import type { NodeCredentialAuth } from "./node-store.js";
import { listRecordingJobs, recordingJob } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";

interface AgentJobRecordingScopeInput {
  recordingId: string;
}

interface AgentJobRecordingScopeDependencies {
  credential: NodeCredentialAuth;
  recordingStore: RecordingStore;
}

export async function agentJobRecordingScope(
  input: AgentJobRecordingScopeInput,
  { credential, recordingStore }: AgentJobRecordingScopeDependencies,
) {
  const recording = await recordingStore.find(input.recordingId);
  const target = { id: input.recordingId, type: "recording" } satisfies AuditTarget;

  if (!recording) {
    return {
      error: "Recording not found",
      ok: false,
      reason: "recording_not_found",
      status: 404,
      target,
    } as const;
  }

  if (recording.nodeId !== credential.nodeId) {
    return {
      error: "Node credential cannot access this recording",
      ok: false,
      reason: "node_scope_denied",
      status: 403,
      target: { ...target, name: recording.name },
    } as const;
  }

  return { ok: true, recording } as const;
}

interface AgentCacheFileJobScopeInput {
  jobId?: string;
}

interface AgentCacheFileJobScopeDependencies {
  credential: NodeCredentialAuth;
  recording: RecordingSummary;
}

export async function agentCacheFileJobScope(
  input: AgentCacheFileJobScopeInput,
  { credential, recording }: AgentCacheFileJobScopeDependencies,
) {
  const job = input.jobId
    ? await recordingJob(input.jobId)
    : (await listRecordingJobs()).find(
        (candidate) =>
          candidate.recordingId === recording.id && candidate.nodeId === credential.nodeId,
      );

  if (!input.jobId && !job) {
    return { job: undefined, ok: true } as const;
  }

  if (!job) {
    return {
      error: "Recording job not found",
      ok: false,
      reason: "recording_job_not_found",
      status: 404,
      target: { id: input.jobId, type: "recording_job" } satisfies AuditTarget,
    } as const;
  }

  return (
    agentRecordingJobScopeFailure(job, { credential, recording }) ?? ({ job, ok: true } as const)
  );
}

function agentRecordingJobScopeFailure(
  job: RecordingJob,
  { credential, recording }: AgentCacheFileJobScopeDependencies,
) {
  const target = { id: job.id, type: "recording_job" } satisfies AuditTarget;

  if (job.nodeId !== credential.nodeId) {
    return {
      error: "Node credential cannot access this job",
      ok: false,
      reason: "node_scope_denied",
      status: 403,
      target,
    } as const;
  }

  if (job.recordingId !== recording.id) {
    return {
      error: "Recording job does not match this recording",
      ok: false,
      reason: "recording_job_scope_denied",
      status: 403,
      target,
    } as const;
  }

  return undefined;
}
