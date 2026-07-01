import type { RecordingSummary } from "@rakkr/shared";

import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import { listRecordingChunksForRecording } from "./recording-chunks.js";
import type { RecordingStore } from "./recording-store.js";

// A chunk in any of these states has secured captured audio on the controller,
// so the recording has real progress worth preserving as `partial`.
const PRESERVED_CHUNK_STATUSES = new Set(["cached", "uploading", "uploaded", "partial"]);

interface AgentJobTerminalRecordingDependencies {
  healthEventStore: HealthEventStore;
  recordingStore: RecordingStore;
}

interface AgentJobTerminalRecordingInput {
  jobId: string;
  reason: string;
  terminalState: "cancelled" | "failed";
}

export async function markAgentJobTerminalRecording(
  recording: RecordingSummary,
  input: AgentJobTerminalRecordingInput,
  { healthEventStore, recordingStore }: AgentJobTerminalRecordingDependencies,
) {
  const healthEvent = await createTerminalHealthEvent(recording, input, healthEventStore);
  // A chunked recording uploads chunks as it captures. If the job ends (e.g. a
  // lease expiry while capture continues) after chunks are already secured, the
  // recording is `partial`, not `failed` — the captured audio is preserved.
  const chunks = await listRecordingChunksForRecording(recording.id);
  const hasPreservedChunks = chunks.some((chunk) => PRESERVED_CHUNK_STATUSES.has(chunk.status));
  const updated = {
    ...recording,
    status: terminalRecordingStatus(recording, input.terminalState, hasPreservedChunks),
  };

  await recordingStore.save(updated);
  await syncRecordingHealth(healthEventStore, recordingStore, recording.id);
  const synced = (await recordingStore.find(recording.id)) ?? updated;

  return {
    ...synced,
    healthEventId: healthEvent?.id,
    terminalState: input.terminalState,
  };
}

async function createTerminalHealthEvent(
  recording: RecordingSummary,
  input: AgentJobTerminalRecordingInput,
  healthEventStore: HealthEventStore,
) {
  if (input.terminalState === "cancelled" && input.reason === "controller_stop_requested") {
    return undefined;
  }

  return healthEventStore.create({
    details: {
      jobId: input.jobId,
      reason: input.reason,
      source: "recording_job_terminal",
      terminalState: input.terminalState,
    },
    nodeId: recording.nodeId,
    recordingId: recording.id,
    scheduleId: recording.scheduleId,
    severity: input.terminalState === "failed" ? "critical" : "warning",
    type: `controller.recording.job_${input.terminalState}`,
  });
}

function terminalRecordingStatus(
  recording: RecordingSummary,
  terminalState: "cancelled" | "failed",
  hasPreservedChunks: boolean,
): RecordingSummary["status"] {
  if (terminalState === "failed") {
    // Preserve already-secured chunk progress instead of discarding it.
    return hasPreservedChunks ? "partial" : "failed";
  }

  return recording.status === "cached" || recording.status === "uploaded"
    ? recording.status
    : "completed";
}
