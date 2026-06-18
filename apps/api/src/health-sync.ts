import type { HealthEvent, RecordingSummary } from "@rakkr/shared";

import type { HealthEventStore } from "./health-store.js";
import type { RecordingStore } from "./recording-store.js";

export async function syncRecordingHealth(
  healthEventStore: HealthEventStore,
  recordingStore: RecordingStore,
  recordingId: string | undefined,
) {
  if (!recordingId) {
    return;
  }

  const recording = await recordingStore.find(recordingId);

  if (!recording) {
    return;
  }

  const activeEvents = (await healthEventStore.list({ limit: 500, recordingId })).filter(
    (event) => event.status !== "resolved",
  );
  const nextHealth = recordingHealthStatus(activeEvents);

  if (recording.healthStatus !== nextHealth) {
    await recordingStore.save({
      ...recording,
      healthStatus: nextHealth,
    });
  }
}

export function recordingHealthStatus(events: HealthEvent[]): RecordingSummary["healthStatus"] {
  if (events.some((event) => event.severity === "critical")) {
    return "critical";
  }

  if (events.some((event) => event.severity === "warning")) {
    return "warning";
  }

  return "healthy";
}
