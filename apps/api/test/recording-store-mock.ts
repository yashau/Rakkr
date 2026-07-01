import type { RecordingSummary } from "@rakkr/shared";

import type { RecordingStore } from "../src/recording-store.js";

// Shared in-memory RecordingStore mock for route/runner tests, including the
// status compare-and-set (`transition`) the stop/terminal/retention/reconcile
// paths rely on. `delete` is a no-op here (these tests don't exercise deletion).
export function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete() {
      return undefined;
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      } else {
        recordings.unshift(recording);
      }
    },
    async transition(recording, allowedFrom) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);
      const current = recordings[index];

      if (!current || !allowedFrom.includes(current.status)) {
        return undefined;
      }

      recordings[index] = recording;

      return recording;
    },
  };
}
