import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduleSummary } from "@rakkr/shared";

import { scheduleActionState, schedulePageActionPermissions } from "./schedule-page-helpers";

test("schedule page permissions require schedule manage for write actions", () => {
  assert.deepEqual(schedulePageActionPermissions(["schedule:read"]), {
    canRead: true,
    canReadAudit: false,
    canReadNodes: false,
    canManage: false,
  });
  assert.deepEqual(
    schedulePageActionPermissions(["audit:read", "node:read", "schedule:read", "schedule:manage"]),
    {
      canRead: true,
      canReadAudit: true,
      canReadNodes: true,
      canManage: true,
    },
  );
});

test("schedule action state mirrors enabled and next-run readiness", () => {
  assert.deepEqual(
    scheduleActionState(schedule({ enabled: true, nextRunAt: "2026-06-19T15:30:00.000Z" }), {
      canRead: true,
      canReadAudit: true,
      canReadNodes: true,
      canManage: true,
    }),
    {
      canDelete: true,
      canEdit: true,
      canRunNow: true,
      canSkipNext: true,
    },
  );
  assert.deepEqual(
    scheduleActionState(schedule({ enabled: false, nextRunAt: "2026-06-19T15:30:00.000Z" }), {
      canRead: true,
      canReadAudit: true,
      canReadNodes: true,
      canManage: true,
    }),
    {
      canDelete: true,
      canEdit: true,
      canRunNow: false,
      canSkipNext: false,
    },
  );
  assert.deepEqual(
    scheduleActionState(schedule({ enabled: true, nextRunAt: undefined }), {
      canRead: true,
      canReadAudit: true,
      canReadNodes: true,
      canManage: true,
    }),
    {
      canDelete: true,
      canEdit: true,
      canRunNow: true,
      canSkipNext: false,
    },
  );
  assert.deepEqual(
    scheduleActionState(schedule({ enabled: true, nextRunAt: "2026-06-19T15:30:00.000Z" }), {
      canRead: true,
      canReadAudit: false,
      canReadNodes: false,
      canManage: false,
    }),
    {
      canDelete: false,
      canEdit: false,
      canRunNow: false,
      canSkipNext: false,
    },
  );
});

function schedule(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    enabled: true,
    folderTemplate: "meetings/{yyyy}/{mm}",
    id: "sched_test",
    name: "Council Weekly",
    nextRunAt: "2026-06-19T15:30:00.000Z",
    nodeId: "node_test",
    recurrence: {
      daysOfWeek: ["monday"],
      endTime: "10:00",
      interval: 1,
      mode: "weekly",
      startTime: "09:00",
    },
    recordingProfileId: "profile_voice",
    room: "Council Chamber",
    tags: ["voice"],
    timezone: "UTC",
    titleTemplate: "Council {yyyy}-{mm}-{dd}",
    uploadPolicyId: "upload_stub",
    watchdogPolicyId: "watchdog_voice",
    ...input,
  };
}
