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

  // Aggregate over EVERY non-resolved event for the recording, not the newest
  // 500 of all statuses (`list` caps at 500). A long-open critical event with an
  // early openedAt would otherwise be pushed out of that window by later
  // flapping/resolved churn, silently dropping the recording's critical badge.
  // Open events are few; the resolved churn is what the cap truncated.
  const activeEvents = (await healthEventStore.listAll({ recordingId })).filter(
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
