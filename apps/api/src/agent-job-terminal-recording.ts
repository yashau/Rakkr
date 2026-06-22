import type { RecordingSummary } from "@rakkr/shared";

import type { HealthEventStore } from "./health-store.js";
import { syncRecordingHealth } from "./health-sync.js";
import type { RecordingStore } from "./recording-store.js";

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
  const updated = {
    ...recording,
    status: terminalRecordingStatus(recording, input.terminalState),
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
): RecordingSummary["status"] {
  if (terminalState === "failed") {
    return "failed";
  }

  return recording.status === "cached" || recording.status === "uploaded"
    ? recording.status
    : "completed";
}
