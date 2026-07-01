import assert from "node:assert/strict";
import test from "node:test";
import type { HealthEvent, RecordingSummary } from "@rakkr/shared";
import type { RecordingStore } from "../src/recording-store.js";

process.env.DATABASE_URL = "";

const { createHealthEventStore } = await import("../src/health-store.js");
const { syncRecordingHealth } = await import("../src/health-sync.js");
const { memoryRecordingStore } = await import("./recording-store-mock.js");

test("R13-4: recording health reflects an open critical event beyond the newest 500", async () => {
  const recordingId = "rec_health_churn";
  const events: HealthEvent[] = [
    // A long-open critical event with the EARLIEST openedAt.
    healthEvent({
      id: "health_open_critical",
      openedAt: "2026-06-01T00:00:00.000Z",
      recordingId,
      severity: "critical",
      status: "open",
      type: "watchdog.flatline",
    }),
  ];
  // 500 newer resolved events push the still-open critical out of any 500-capped
  // window (matching is ordered openedAt desc, and `list` caps at 500).
  for (let index = 0; index < 500; index += 1) {
    events.push(
      healthEvent({
        id: `health_resolved_${index}`,
        openedAt: new Date(Date.parse("2026-06-10T00:00:00.000Z") + index * 60_000).toISOString(),
        recordingId,
        severity: "warning",
        status: "resolved",
        type: "watchdog.clipping",
      }),
    );
  }
  const healthEventStore = createHealthEventStore("", events);
  const recordingStore = memoryRecordingStore([
    recording({ healthStatus: "healthy", id: recordingId }),
  ]);

  await syncRecordingHealth(healthEventStore, recordingStore, recordingId);

  // Pre-fix the newest-500 window held only resolved events, so health synced to
  // "healthy" and hid the still-open critical.
  assert.equal((await recordingStore.find(recordingId))?.healthStatus, "critical");
});

test("R13-8: health sync does not clobber a recording secured mid-sync (status CAS)", async () => {
  const recordingId = "rec_health_race";
  const healthEventStore = createHealthEventStore("", [
    healthEvent({ id: "health_race_critical", recordingId, severity: "critical", status: "open" }),
  ]);
  const secured = recording({
    cached: true,
    cachePath: "scheduled/rec_health_race.mp3",
    healthStatus: "healthy",
    id: recordingId,
    status: "cached",
  });
  const preSecure = recording({ healthStatus: "healthy", id: recordingId, status: "recording" });
  let stored: RecordingSummary = preSecure;
  let findCalls = 0;
  const recordingStore: RecordingStore = {
    async create() {},
    async delete() {
      return undefined;
    },
    async find() {
      findCalls += 1;
      const snapshot = { ...stored };

      if (findCalls === 1) {
        // A concurrent cache-secure lands right after the first read.
        stored = { ...secured };
      }

      return snapshot;
    },
    async list() {
      return [stored];
    },
    async save(next) {
      stored = next;
    },
    async transition(next, allowedFrom) {
      if (!allowedFrom.includes(stored.status)) {
        return undefined;
      }

      stored = next;

      return next;
    },
  };

  await syncRecordingHealth(healthEventStore, recordingStore, recordingId);

  // Pre-fix a full-row save wrote back the stale "recording" snapshot, reverting
  // the secure. The CAS re-reads and preserves status + cachePath while still
  // applying the derived health status.
  assert.equal(stored.healthStatus, "critical");
  assert.equal(stored.status, "cached");
  assert.equal(stored.cachePath, "scheduled/rec_health_race.mp3");
});

function healthEvent(
  input: Partial<HealthEvent> & Pick<HealthEvent, "id" | "severity" | "status">,
) {
  return {
    acknowledgedAt: null,
    details: {},
    openedAt: "2026-06-10T00:00:00.000Z",
    resolvedAt: input.status === "resolved" ? "2026-06-10T00:05:00.000Z" : null,
    suppressedAt: null,
    suppressedUntil: null,
    type: "watchdog.flatline",
    ...input,
  } satisfies HealthEvent;
}

function recording(input: Partial<RecordingSummary>): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: "rec",
    name: "Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: [],
    ...input,
  };
}
