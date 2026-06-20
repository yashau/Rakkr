import type { RecorderNode, RecordingJob, RecordingSummary, ScheduleSummary } from "@rakkr/shared";

import { recordingJobTargetOptions } from "./recording-job-targets.js";
import { createRecordingJob } from "./recording-jobs.js";
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
}): Promise<QueuedScheduledRecording[]> {
  const profile = await settingsStore.findRecordingProfile(schedule.recordingProfileId);
  const tracks = scheduleRecordingTrackPlans(schedule, profile);
  const queued: QueuedScheduledRecording[] = [];

  for (const track of tracks) {
    const recording = materializeScheduledRecording(schedule, node, now, track);

    await recordingStore.create(recording);
    queued.push({
      job: await createRecordingJob(
        recording,
        await recordingJobTargetOptions({
          captureBackend: schedule.captureBackend,
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

  return queued;
}

export function scheduledRecordingSegmentSnapshot(queued: QueuedScheduledRecording) {
  return {
    durationSeconds: queued.track.durationSeconds,
    jobId: queued.job.id,
    offsetSeconds: queued.track.offsetSeconds,
    recordingId: queued.recording.id,
    trackIndex: queued.track.trackIndex,
    trackTotal: queued.track.trackTotal,
  };
}
