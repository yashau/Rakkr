import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultVoiceRecordingProfile,
  recordingProfileSchema,
  recordingProfileUpdateSchema,
} from "@rakkr/shared";

test("recording-profile schema stays permissive on read but bounds bitrate on input", () => {
  // recordingProfileSchema also parses persisted rows (recordingProfileFromRow),
  // so it must accept any previously-stored bitrate — the 512 kbps ceiling lives
  // on the input (update) schema, not here (a `.max` here would reject a legacy
  // over-cap profile row on read).
  assert.equal(recordingProfileSchema.safeParse(defaultVoiceRecordingProfile).success, true);
  assert.equal(
    recordingProfileSchema.safeParse({ ...defaultVoiceRecordingProfile, bitrateKbps: 800 }).success,
    true,
    "the data schema must load legacy over-cap rows, not reject them",
  );

  // The input path (update) enforces the ceiling.
  assert.equal(recordingProfileUpdateSchema.safeParse({ bitrateKbps: 800 }).success, false);
  assert.equal(recordingProfileUpdateSchema.safeParse({ bitrateKbps: 512 }).success, true);
});
