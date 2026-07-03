import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScheduleRecurrence, ScheduleSummary } from "@rakkr/shared";

import {
  nextRunAtForRecurrence,
  occurrenceLocalDateIso,
  previewScheduleOccurrences,
  scheduleRecordingTrackPlans,
  scheduleRecordingDurationSeconds,
  skipNextScheduleOccurrence,
  windowScheduleOccurrences,
} from "../src/schedule-engine";

describe("schedule recurrence engine", () => {
  it("does not crash previewing a schedule with a malformed nextRunAt", () => {
    // A malformed nextRunAt (e.g. a corrupted row) must not throw a RangeError
    // via new Date(NaN).toISOString() — it should break gracefully like
    // windowScheduleOccurrences does.
    const schedule = scheduleFixture({
      nextRunAt: "not-a-valid-date",
      recurrence: {
        daysOfWeek: ["monday"],
        endTime: "10:00",
        interval: 1,
        mode: "weekly",
        startTime: "09:00",
      },
    });

    assert.deepEqual(
      previewScheduleOccurrences(schedule, 3, new Date("2026-06-15T08:00:00.000Z")),
      [],
    );
  });

  it("previews weekly interval windows with start-early and stop-late buffers", () => {
    const schedule = scheduleFixture({
      recurrence: {
        daysOfWeek: ["monday", "wednesday"],
        endTime: "10:00",
        interval: 2,
        mode: "weekly",
        startEarlySeconds: 300,
        startTime: "09:00",
        stopLateSeconds: 120,
      },
    });

    const occurrences = previewScheduleOccurrences(
      schedule,
      3,
      new Date("2026-06-15T08:54:00.000Z"),
    );

    assert.deepEqual(occurrences, [
      {
        recordingEndAt: "2026-06-15T10:02:00.000Z",
        recordingStartAt: "2026-06-15T08:55:00.000Z",
        scheduledStartAt: "2026-06-15T09:00:00.000Z",
      },
      {
        recordingEndAt: "2026-06-17T10:02:00.000Z",
        recordingStartAt: "2026-06-17T08:55:00.000Z",
        scheduledStartAt: "2026-06-17T09:00:00.000Z",
      },
      {
        recordingEndAt: "2026-06-29T10:02:00.000Z",
        recordingStartAt: "2026-06-29T08:55:00.000Z",
        scheduledStartAt: "2026-06-29T09:00:00.000Z",
      },
    ]);
  });

  it("skips one-off exceptions and paused local date ranges", () => {
    const recurrence: ScheduleRecurrence = {
      daysOfWeek: ["monday", "wednesday"],
      endTime: "10:00",
      exceptions: [
        { action: "skip", date: "2026-06-15" },
        { action: "pause", endDate: "2026-06-18", startDate: "2026-06-17" },
      ],
      interval: 1,
      mode: "weekly",
      startTime: "09:00",
    };

    assert.equal(
      nextRunAtForRecurrence(recurrence, "UTC", undefined, new Date("2026-06-14T12:00:00.000Z")),
      "2026-06-22T09:00:00.000Z",
    );
  });

  it("clamps monthly day schedules to shorter months", () => {
    const recurrence: ScheduleRecurrence = {
      dayOfMonth: 31,
      endTime: "11:00",
      interval: 1,
      mode: "monthly",
      startTime: "10:00",
    };

    assert.equal(
      nextRunAtForRecurrence(recurrence, "UTC", undefined, new Date("2026-02-01T00:00:00.000Z")),
      "2026-02-28T10:00:00.000Z",
    );
  });

  it("shifts a spring-forward gap start time forward past the DST gap", () => {
    // 2026-03-08 in America/New_York: clocks jump 02:00 -> 03:00, so 02:30 does
    // not exist. Pre-fix the fixed point oscillated on the iteration count and
    // could resolve backward to 01:30 local (06:30Z); it must deterministically
    // shift forward to 03:30 local (07:30Z).
    const recurrence: ScheduleRecurrence = {
      endTime: "04:00",
      interval: 1,
      mode: "daily",
      startTime: "02:30",
    };

    assert.equal(
      nextRunAtForRecurrence(
        recurrence,
        "America/New_York",
        undefined,
        new Date("2026-03-08T00:00:00.000Z"),
      ),
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("keeps a normal (non-DST) daily start time exact", () => {
    const recurrence: ScheduleRecurrence = {
      endTime: "10:00",
      interval: 1,
      mode: "daily",
      startTime: "09:00",
    };

    // A day with no transition round-trips to the exact requested wall time.
    assert.equal(
      nextRunAtForRecurrence(
        recurrence,
        "America/New_York",
        undefined,
        new Date("2026-06-14T00:00:00.000Z"),
      ),
      "2026-06-14T13:00:00.000Z",
    );
  });

  it("computes overnight recording duration with both buffer directions", () => {
    const schedule = scheduleFixture({
      recurrence: {
        endTime: "00:15",
        interval: 1,
        mode: "daily",
        startEarlySeconds: 300,
        startTime: "23:30",
        stopLateSeconds: 600,
      },
    });

    assert.equal(scheduleRecordingDurationSeconds(schedule), 3_600);
  });

  it("keeps a scheduled recording window as a single track for chunked capture", () => {
    const schedule = scheduleFixture({
      recurrence: {
        endTime: "11:00",
        interval: 1,
        mode: "daily",
        startTime: "09:00",
      },
    });

    // Pre-splitting into separate per-track recordings is retired; a window is one
    // recording whose continuous capture is segmented by the profile's chunkSeconds.
    const tracks = scheduleRecordingTrackPlans(schedule);

    assert.deepEqual(tracks, [{ durationSeconds: 7_200, offsetSeconds: 0 }]);
  });

  it("adds skip-next exceptions and advances to the next eligible occurrence", () => {
    const schedule = scheduleFixture({
      nextRunAt: "2026-06-15T08:55:00.000Z",
      recurrence: {
        daysOfWeek: ["monday", "wednesday"],
        endTime: "10:00",
        interval: 1,
        mode: "weekly",
        startEarlySeconds: 300,
        startTime: "09:00",
      },
    });

    const skipped = skipNextScheduleOccurrence(schedule);

    assert.equal(skipped?.occurrenceDate, "2026-06-15");
    assert.equal(skipped?.updates.nextRunAt, "2026-06-17T08:55:00.000Z");
    assert.deepEqual(skipped?.updates.recurrence.exceptions, [
      { action: "skip", date: "2026-06-15" },
    ]);
  });

  it("windows occurrences within [start, end] independent of now", () => {
    const schedule = scheduleFixture({
      recurrence: {
        endTime: "10:00",
        interval: 1,
        mode: "daily",
        startTime: "09:00",
      },
    });

    const occurrences = windowScheduleOccurrences(
      schedule,
      new Date("2026-06-15T00:00:00.000Z"),
      new Date("2026-06-17T23:59:59.000Z"),
    );

    assert.deepEqual(
      occurrences.map((occurrence) => occurrence.recordingStartAt),
      ["2026-06-15T09:00:00.000Z", "2026-06-16T09:00:00.000Z", "2026-06-17T09:00:00.000Z"],
    );
  });

  it("windows return nothing for manual/always_on schedules", () => {
    const start = new Date("2026-06-15T00:00:00.000Z");
    const end = new Date("2026-07-15T00:00:00.000Z");

    assert.deepEqual(windowScheduleOccurrences(scheduleFixture(), start, end), []);
    assert.deepEqual(
      windowScheduleOccurrences(scheduleFixture({ recurrence: { mode: "always_on" } }), start, end),
      [],
    );
  });

  it("treats a one-off duration as its recording length and end", () => {
    const schedule = scheduleFixture({
      recurrence: { durationSeconds: 3_600, mode: "once", startsAt: "2026-06-20T14:00:00.000Z" },
    });

    assert.equal(scheduleRecordingDurationSeconds(schedule), 3_600);

    const [occurrence] = windowScheduleOccurrences(
      schedule,
      new Date("2026-06-20T00:00:00.000Z"),
      new Date("2026-06-21T00:00:00.000Z"),
    );

    assert.equal(occurrence?.recordingStartAt, "2026-06-20T14:00:00.000Z");
    assert.equal(occurrence?.recordingEndAt, "2026-06-20T15:00:00.000Z");
  });

  it("computes the local occurrence date for a run", () => {
    const schedule = scheduleFixture({
      recurrence: { endTime: "01:00", interval: 1, mode: "daily", startTime: "23:30" },
      timezone: "America/New_York",
    });

    // 23:30 America/New_York on 2026-06-20 is 03:30Z the next day.
    assert.equal(occurrenceLocalDateIso(schedule, "2026-06-21T03:30:00.000Z"), "2026-06-20");
  });
});

function scheduleFixture(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    enabled: true,
    folderTemplate: "Meetings/{{date}}",
    id: "sched_test",
    name: "Test Schedule",
    nodeId: "node_test",
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    recurrence: { mode: "manual" },
    room: "Council Chamber",
    tags: ["voice", "scheduled"],
    timezone: "UTC",
    titleTemplate: "{{date}}_{{time}}_{{schedule.name}}",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...overrides,
  };
}
