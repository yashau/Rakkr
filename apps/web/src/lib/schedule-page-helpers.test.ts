import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduleSummary } from "@rakkr/shared";

import {
  emptySchedulePageFilters,
  scheduleActionState,
  scheduleFilterChips,
  scheduleFiltersFromDraft,
  schedulePageActionPermissions,
  schedulePickerFilters,
} from "./schedule-page-helpers";

test("schedule pickers request the full set, not the default page", () => {
  // The API's default schedule page is 50; recordings/health resolve schedule
  // id -> name and populate filter dropdowns from this query, so omitting `limit`
  // drops every schedule past the first page and leaves those recordings/events
  // with an unresolved schedule label. The picker must fetch beyond one page.
  const filters = schedulePickerFilters();

  assert.ok(filters.limit > 50, "picker must fetch beyond the default 50-row page");
  assert.equal(filters.limit, 200, "requests the API's max page size (PAGE_POLICY.default)");
});

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

test("schedule filters trim API filters and expose active chips", () => {
  const filters = scheduleFiltersFromDraft({
    ...emptySchedulePageFilters,
    captureBackend: "pipewire",
    captureInterfaceId: " iface_pipewire ",
    enabled: "true",
    nodeId: " node_1 ",
    search: " council ",
  });

  assert.deepEqual(filters, {
    captureBackend: "pipewire",
    captureInterfaceId: "iface_pipewire",
    enabled: "true",
    nodeId: "node_1",
    search: "council",
  });
  assert.deepEqual(scheduleFilterChips(filters), [
    { key: "search", label: "search", value: "council" },
    { key: "enabled", label: "state", value: "enabled" },
    { key: "nodeId", label: "node", value: "node_1" },
    { key: "captureBackend", label: "backend", value: "pipewire" },
    { key: "captureInterfaceId", label: "interface", value: "iface_pipewire" },
  ]);
});

function schedule(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
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
    retentionPolicyId: "retention_keep",
    room: "Council Chamber",
    tags: ["voice"],
    timezone: "UTC",
    titleTemplate: "Council {yyyy}-{mm}-{dd}",
    uploadPolicyIds: ["upload_stub"],
    watchdogPolicyId: "watchdog_voice",
    ...input,
  };
}
