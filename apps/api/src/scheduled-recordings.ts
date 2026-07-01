import type { RecorderNode, RecordingJob, RecordingSummary, ScheduleSummary } from "@rakkr/shared";

import { withCaptureStartLock } from "./capture-start-lock.js";
import {
  buildCaptureClaims,
  detectChannelConflicts,
  resolveCaptureGroupId,
  type ClaimedChannels,
} from "./channel-conflicts.js";
import { recordingJobTargetOptions } from "./recording-job-targets.js";
import { createRecordingJob, listRecordingJobs } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import {
  materializeScheduledRecording,
  scheduleRecordingTrackPlans,
  type ScheduledRecordingTrack,
} from "./schedule-engine.js";
import type { SettingsStore } from "./settings-store.js";

export interface QueuedScheduledRecording {
  job: RecordingJob;
  recording: RecordingSummary;
  track: ScheduledRecordingTrack;
}

export interface ScheduledRecordingConflict {
  busyChannels: number[];
  captureInterfaceId?: string;
  conflictingJobId: string;
  conflictingRecordingId: string;
}

export type QueueScheduledRecordingsResult =
  | { queued: QueuedScheduledRecording[]; status: "queued" }
  | { conflict: ScheduledRecordingConflict; status: "deferred" };

export async function queueScheduledRecordings({
  node,
  now = new Date(),
  recordingStore,
  schedule,
  settingsStore,
}: {
  node: RecorderNode;
  now?: Date;
  recordingStore: RecordingStore;
  schedule: ScheduleSummary;
  settingsStore: SettingsStore;
}): Promise<QueueScheduledRecordingsResult> {
  const profile = await settingsStore.findRecordingProfile(schedule.recordingProfileId);
  const tracks = scheduleRecordingTrackPlans(schedule);

  const resolvedInterfaceId =
    schedule.captureInterfaceId ??
    process.env.RAKKR_AGENT_CAPTURE_INTERFACE_ID ??
    node.interfaces[0]?.id;
  const channels: ClaimedChannels =
    schedule.captureChannelSelection && schedule.captureChannelSelection.length > 0
      ? schedule.captureChannelSelection
      : "all";

  // Serialize the conflict check -> create per node (shared with the ad-hoc
  // start route) so a scheduled occurrence and a concurrent ad-hoc/scheduled
  // start can't both pass the channel-conflict guard against a pre-create
  // snapshot and double-create on the same interface.
  return withCaptureStartLock(node.id, async () => {
    const activeJobs = await listRecordingJobs();
    const recordingsById = new Map((await recordingStore.list()).map((entry) => [entry.id, entry]));
    const captureClaims = buildCaptureClaims(activeJobs, recordingsById);
    const startMs = now.getTime();
    const occurrenceEndOffsetSeconds = Math.max(
      ...tracks.map(
        (track) => track.offsetSeconds + (track.durationSeconds ?? defaultCaptureSeconds()),
      ),
    );

    // Defer the whole occurrence if any requested channel is busy at any point in
    // its window; the recording that already holds the channels keeps running.
    const conflicts = detectChannelConflicts(captureClaims, {
      captureInterfaceId: resolvedInterfaceId,
      channels,
      endMs: startMs + occurrenceEndOffsetSeconds * 1_000,
      nodeId: node.id,
      startMs,
    });

    if (conflicts.length > 0) {
      const busyChannels = [...new Set(conflicts.flatMap((conflict) => conflict.channels))].sort(
        (left, right) => left - right,
      );
      const conflictingClaim = conflicts[0].claim;

      return {
        conflict: {
          busyChannels,
          captureInterfaceId: resolvedInterfaceId,
          conflictingJobId: conflictingClaim.jobId,
          conflictingRecordingId: conflictingClaim.recordingId,
        },
        status: "deferred",
      };
    }

    const queued: QueuedScheduledRecording[] = [];

    for (const track of tracks) {
      const recording = materializeScheduledRecording(schedule, node, now, track);
      const trackStartMs = startMs + track.offsetSeconds * 1_000;
      // Each track joins an overlapping capture session on the interface (so
      // disjoint-channel schedules share one device capture) or opens a new one.
      const captureGroupId = resolveCaptureGroupId(captureClaims, {
        captureInterfaceId: resolvedInterfaceId,
        channels,
        endMs: trackStartMs + (track.durationSeconds ?? defaultCaptureSeconds()) * 1_000,
        nodeId: node.id,
        startMs: trackStartMs,
      });

      await recordingStore.create(recording);
      queued.push({
        job: await createRecordingJob(
          recording,
          await recordingJobTargetOptions({
            captureBackend: schedule.captureBackend,
            captureChannelSelection: schedule.captureChannelSelection ?? undefined,
            captureGroupId,
            captureInterfaceId: schedule.captureInterfaceId,
            channelMode: schedule.channelMode ?? undefined,
            durationSeconds: track.durationSeconds,
            node,
            profile,
            recordingProfileId: recording.recordingProfileId,
            settingsStore,
          }),
        ),
        recording,
        track,
      });
    }

    return { queued, status: "queued" };
  });
}

export function scheduledRecordingSegmentSnapshot(queued: QueuedScheduledRecording) {
  return {
    captureChannelSelection: queued.job.command.captureChannelSelection,
    captureGroupId: queued.job.command.captureGroupId,
    captureInterfaceId: queued.job.command.captureInterfaceId,
    durationSeconds: queued.track.durationSeconds,
    jobId: queued.job.id,
    offsetSeconds: queued.track.offsetSeconds,
    recordingId: queued.recording.id,
    trackIndex: queued.track.trackIndex,
    trackTotal: queued.track.trackTotal,
  };
}

function defaultCaptureSeconds() {
  const parsed = Number(process.env.RAKKR_AGENT_CAPTURE_SECONDS);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3_600;
}
