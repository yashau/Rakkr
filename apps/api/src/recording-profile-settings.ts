import {
  recordingProfileSchema,
  type RecordingProfile,
  type RecordingProfileUpdate,
} from "@rakkr/shared";

export function applyRecordingProfileUpdate(
  existing: RecordingProfile,
  update: RecordingProfileUpdate,
  profileId: string,
) {
  const next: RecordingProfile = {
    ...existing,
    ...update,
    id: profileId,
    maxTrackSeconds: update.maxTrackSeconds ?? existing.maxTrackSeconds,
  };

  if (update.maxTrackSeconds === null) {
    delete next.maxTrackSeconds;
  }

  return recordingProfileSchema.parse(next);
}

export function recordingProfileMaxTrackSeconds(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function recordingProfileSettings(profile: RecordingProfile) {
  const settings: Record<string, unknown> = {};

  if (profile.maxTrackSeconds) {
    settings.maxTrackSeconds = profile.maxTrackSeconds;
  }

  return settings;
}
