import { randomUUID } from "node:crypto";
import type { RecordingJob, RecordingJobStatus, RecordingSummary } from "@rakkr/shared";

// Jobs in these states are holding (or about to hold) a capture window and so
// claim their channels for conflict detection.
export const activeCaptureJobStatuses = new Set<RecordingJobStatus>([
  "queued",
  "running",
  "stop_requested",
]);

// Sentinel interface key for jobs that did not pin an interface (node default).
// Two node-default captures on the same node contend for the same hardware, so
// they share this key.
const NODE_DEFAULT_INTERFACE_KEY = "__node_default__";

// `"all"` means the capture owns the whole interface (no channel selection),
// which conflicts with any other capture on that interface.
export type ClaimedChannels = number[] | "all";

export interface CaptureClaim {
  captureGroupId?: string;
  channels: ClaimedChannels;
  endMs: number;
  interfaceKey: string;
  jobId: string;
  nodeId: string;
  recordingId: string;
  startMs: number;
  status: RecordingJobStatus;
}

export interface CaptureClaimRequest {
  captureInterfaceId?: string;
  channels: ClaimedChannels;
  endMs: number;
  nodeId: string;
  startMs: number;
}

export interface CaptureConflict {
  // Overlapping channels; an empty array means the conflict is over the whole
  // interface (one side did not pin a channel selection).
  channels: number[];
  claim: CaptureClaim;
}

export function interfaceKey(captureInterfaceId: string | undefined): string {
  return captureInterfaceId ?? NODE_DEFAULT_INTERFACE_KEY;
}

export function claimedChannelsFromCommand(command: RecordingJob["command"]): ClaimedChannels {
  const selection = command.captureChannelSelection;

  return selection && selection.length > 0 ? [...selection] : "all";
}

// Translate active jobs into capture claims, using each recording's scheduled
// start (or the job's own start) plus the command duration as the window.
export function buildCaptureClaims(
  jobs: RecordingJob[],
  recordings: Map<string, RecordingSummary>,
  options: { excludeRecordingId?: string } = {},
): CaptureClaim[] {
  const claims: CaptureClaim[] = [];

  for (const job of jobs) {
    if (!activeCaptureJobStatuses.has(job.status)) {
      continue;
    }

    if (options.excludeRecordingId && job.recordingId === options.excludeRecordingId) {
      continue;
    }

    const startMs = captureStartMs(job, recordings.get(job.recordingId));

    if (startMs === undefined) {
      continue;
    }

    claims.push({
      captureGroupId: job.command.captureGroupId,
      channels: claimedChannelsFromCommand(job.command),
      endMs: startMs + job.command.durationSeconds * 1_000,
      interfaceKey: interfaceKey(job.command.captureInterfaceId),
      jobId: job.id,
      nodeId: job.nodeId,
      recordingId: job.recordingId,
      startMs,
      status: job.status,
    });
  }

  return claims;
}

export function detectChannelConflicts(
  claims: CaptureClaim[],
  request: CaptureClaimRequest,
): CaptureConflict[] {
  const requestKey = interfaceKey(request.captureInterfaceId);
  const conflicts: CaptureConflict[] = [];

  for (const claim of claims) {
    if (claim.nodeId !== request.nodeId || claim.interfaceKey !== requestKey) {
      continue;
    }

    if (!windowsOverlap(request.startMs, request.endMs, claim.startMs, claim.endMs)) {
      continue;
    }

    const overlap = overlappingChannels(request.channels, claim.channels);

    if (overlap !== "none") {
      conflicts.push({ channels: overlap, claim });
    }
  }

  return conflicts;
}

// Count distinct interfaces this node is actively capturing from. Each distinct
// interface is one physical capture session; the node capacity bounds how many
// sessions can run at once.
export function activeCaptureSessionKeys(claims: CaptureClaim[], nodeId: string): Set<string> {
  const keys = new Set<string>();

  for (const claim of claims) {
    if (claim.nodeId === nodeId) {
      keys.add(claim.interfaceKey);
    }
  }

  return keys;
}

// If an overlapping capture session already exists on the requested interface,
// the new job joins it (shares one device capture); otherwise it starts a fresh
// session group. Callers must ensure channels are disjoint first.
export function resolveCaptureGroupId(
  claims: CaptureClaim[],
  request: CaptureClaimRequest,
  newGroupId: () => string = defaultCaptureGroupId,
): string {
  const requestKey = interfaceKey(request.captureInterfaceId);
  const joinable = claims.find(
    (claim) =>
      claim.nodeId === request.nodeId &&
      claim.interfaceKey === requestKey &&
      claim.captureGroupId !== undefined &&
      windowsOverlap(request.startMs, request.endMs, claim.startMs, claim.endMs),
  );

  return joinable?.captureGroupId ?? newGroupId();
}

export function defaultCaptureGroupId(): string {
  return `cap_${randomUUID()}`;
}

function captureStartMs(job: RecordingJob, recording: RecordingSummary | undefined) {
  const candidate = job.startedAt ?? recording?.recordedAt ?? job.createdAt;
  const parsed = Date.parse(candidate);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

function overlappingChannels(request: ClaimedChannels, claim: ClaimedChannels): number[] | "none" {
  if (request === "all" && claim === "all") {
    return [];
  }

  if (request === "all") {
    return claim === "all" ? [] : [...claim];
  }

  if (claim === "all") {
    return [...request];
  }

  const claimSet = new Set(claim);
  const overlap = request.filter((channel) => claimSet.has(channel));

  return overlap.length > 0 ? overlap : "none";
}
