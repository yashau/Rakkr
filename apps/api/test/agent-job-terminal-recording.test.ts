import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingChunk, RecordingSummary } from "@rakkr/shared";

const root = await mkdtemp(path.join(tmpdir(), "rakkr-terminal-recording-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(root, "chunks.json");

const { createHealthEventStore } = await import("../src/health-store.js");
const { markAgentJobTerminalRecording } = await import("../src/agent-job-terminal-recording.js");
const { upsertRecordingChunk } = await import("../src/recording-chunks.js");

test.after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("lease-expiry failure of a chunked recording with secured chunks resolves to partial", async () => {
  const recording = recordingSummary("rec_terminal_chunked");
  await upsertRecordingChunk(chunk(recording.id, 1, "uploaded"));
  await upsertRecordingChunk(chunk(recording.id, 2, "cached"));

  const recordingStore = memoryRecordingStore([recording]);
  const result = await markAgentJobTerminalRecording(
    recording,
    { jobId: "job_terminal_chunked", reason: "lease_expired", terminalState: "failed" },
    { healthEventStore: createHealthEventStore(""), recordingStore },
  );

  // Pre-fix this was unconditionally "failed", discarding the uploaded chunks.
  assert.equal(result.status, "partial");
  assert.equal((await recordingStore.find(recording.id))?.status, "partial");
});

test("lease-expiry failure of a recording with no chunks stays failed", async () => {
  const recording = recordingSummary("rec_terminal_whole");
  const recordingStore = memoryRecordingStore([recording]);

  const result = await markAgentJobTerminalRecording(
    recording,
    { jobId: "job_terminal_whole", reason: "lease_expired", terminalState: "failed" },
    { healthEventStore: createHealthEventStore(""), recordingStore },
  );

  assert.equal(result.status, "failed");
});

test("G64: lease-expiry failure does not downgrade a recording already secured as cached", async () => {
  // A concurrent cache-file upload secured the recording before the lease
  // reaper's terminal write lands.
  const recording = {
    ...recordingSummary("rec_terminal_secured"),
    cached: true,
    status: "cached" as const,
  };
  const recordingStore = memoryRecordingStore([recording]);

  const result = await markAgentJobTerminalRecording(
    recording,
    { jobId: "job_terminal_secured", reason: "lease_expired", terminalState: "failed" },
    { healthEventStore: createHealthEventStore(""), recordingStore },
  );

  // Pre-fix this clobbered the secured recording to "failed", orphaning its audio
  // while the owning job may have completed.
  assert.equal(result.status, "cached");
  assert.equal((await recordingStore.find(recording.id))?.status, "cached");
});

function chunk(
  recordingId: string,
  index: number,
  status: RecordingChunk["status"],
): RecordingChunk {
  return {
    createdAt: "2026-06-18T12:00:00.000Z",
    durationSeconds: 60,
    id: `${recordingId}:${index}`,
    index,
    jobId: "job_terminal_chunked",
    offsetSeconds: (index - 1) * 60,
    recordingId,
    status,
  };
}

function recordingSummary(id: string): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id,
    name: "Terminal Recording",
    nodeId: "node_terminal",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "recording",
    tags: [],
  };
}

function memoryRecordingStore(recordings: RecordingSummary[]) {
  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
    async delete(recordingId: string) {
      const index = recordings.findIndex((entry) => entry.id === recordingId);

      return index >= 0 ? recordings.splice(index, 1)[0] : undefined;
    },
    async find(recordingId: string) {
      return recordings.find((entry) => entry.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording: RecordingSummary) {
      const index = recordings.findIndex((entry) => entry.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
    async transition(recording: RecordingSummary, allowedFrom: RecordingSummary["status"][]) {
      const index = recordings.findIndex((entry) => entry.id === recording.id);
      const current = recordings[index];

      if (!current || !allowedFrom.includes(current.status)) {
        return undefined;
      }

      recordings[index] = recording;

      return recording;
    },
  };
}
