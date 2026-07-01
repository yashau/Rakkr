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

  if (recording.healthStatus === nextHealth) {
    return;
  }

  // Write healthStatus without carrying a status/cache decision. A plain
  // save({ ...recording, healthStatus }) is a full-column upsert of the row as
  // it was read, so a concurrent upload that secured the recording between our
  // read and write would be reverted (same TOCTOU as the metadata routes).
  // Commit through the status CAS instead; re-read and retry if a concurrent
  // writer moved status (health is derived, so the re-read value still applies).
  for (let attempt = 0; attempt < HEALTH_SYNC_COMMIT_ATTEMPTS; attempt += 1) {
    const current = await recordingStore.find(recordingId);

    if (!current || current.healthStatus === nextHealth) {
      return;
    }

    const committed = await recordingStore.transition({ ...current, healthStatus: nextHealth }, [
      current.status,
    ]);

    if (committed) {
      return;
    }
  }
}

const HEALTH_SYNC_COMMIT_ATTEMPTS = 5;

export function recordingHealthStatus(events: HealthEvent[]): RecordingSummary["healthStatus"] {
  if (events.some((event) => event.severity === "critical")) {
    return "critical";
  }

  if (events.some((event) => event.severity === "warning")) {
    return "warning";
  }

  return "healthy";
}
