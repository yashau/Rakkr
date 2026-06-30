import { randomUUID } from "node:crypto";
import { recordingProfiles as recordingProfilesTable } from "@rakkr/db";
import {
  defaultVoiceRecordingProfile,
  recordingProfileSchema,
  type RecordingProfile,
  type RecordingProfileUpdate,
} from "@rakkr/shared";

type RecordingProfileInsert = typeof recordingProfilesTable.$inferInsert;
type RecordingProfileRow = typeof recordingProfilesTable.$inferSelect;

// Body accepted by the create route/store: a name is required, every other
// profile field is optional and falls back to the built-in voice template so
// operators can add a profile and then refine it in the editor.
export type RecordingProfileCreateInput = Partial<Omit<RecordingProfile, "id">> &
  Pick<RecordingProfile, "name">;

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

export function recordingProfileFromInput(input: RecordingProfileCreateInput) {
  const { id: _unusedId, ...defaults } = defaultVoiceRecordingProfile;

  return recordingProfileSchema.parse({
    ...defaults,
    ...input,
    id: `recording_profile_${randomUUID()}`,
  });
}

export function recordingProfileMaxTrackSeconds(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function recordingProfileSettings(profile: RecordingProfile) {
  const settings: Record<string, unknown> = {};

  if (profile.maxTrackSeconds) {
    settings.maxTrackSeconds = profile.maxTrackSeconds;
  }

  if (profile.enhancement) {
    settings.enhancement = profile.enhancement;
  }

  return settings;
}

export function recordingProfileToRow(profile: RecordingProfile): RecordingProfileInsert {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    codec: profile.codec,
    id: profile.id,
    name: profile.name,
    settings: recordingProfileSettings(profile),
    silenceDetectionEnabled: profile.silenceDetectionEnabled,
    silenceSkipEnabled: profile.silenceSkipEnabled,
    vbr: profile.vbr,
  };
}

export function recordingProfileFromRow(row: RecordingProfileRow): RecordingProfile {
  const settings = recordOrEmpty(row.settings);

  return recordingProfileSchema.parse({
    bitrateKbps: row.bitrateKbps,
    channelMode: row.channelMode,
    codec: row.codec,
    enhancement: settings.enhancement,
    id: row.id,
    maxTrackSeconds: recordingProfileMaxTrackSeconds(settings.maxTrackSeconds),
    name: row.name,
    silenceDetectionEnabled: row.silenceDetectionEnabled,
    silenceSkipEnabled: row.silenceSkipEnabled,
    vbr: row.vbr,
  });
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
