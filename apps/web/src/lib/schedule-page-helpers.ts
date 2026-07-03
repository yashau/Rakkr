import type { Permission, ScheduleSummary } from "@rakkr/shared";

import type { ScheduleFilters } from "@/lib/api";

export type ScheduleFilterKey = keyof ScheduleFilters;

export interface ActiveScheduleFilterChip {
  key: ScheduleFilterKey;
  label: string;
  value: string;
}

export interface SchedulePageFilterDraft {
  captureBackend: "" | NonNullable<ScheduleSummary["captureBackend"]>;
  captureInterfaceId: string;
  enabled: "" | "false" | "true";
  nodeId: string;
  search: string;
}

export interface SchedulePageActionPermissions {
  canRead: boolean;
  canReadAudit: boolean;
  canReadNodes: boolean;
  canManage: boolean;
}

export interface ScheduleActionState {
  canDelete: boolean;
  canEdit: boolean;
  canRunNow: boolean;
  canSkipNext: boolean;
}

export const emptySchedulePageFilters: SchedulePageFilterDraft = {
  captureBackend: "",
  captureInterfaceId: "",
  enabled: "",
  nodeId: "",
  search: "",
};

/**
 * Schedules feed id -> name label maps and filter dropdowns on the recordings
 * and health pages. Fetching without a limit falls back to the list route's
 * server default (50), silently dropping the 51st+ schedule so its recordings
 * and health events render with an unresolved schedule label. 200 is the API's
 * max page size (`PAGE_POLICY.default.maxLimit`); requesting it fetches the full
 * schedule set up to that cap. Deployments beyond 200 schedules need a paginated
 * picker (tracked). Mirrors `nodePickerFilters`.
 */
export const SCHEDULE_PICKER_LIMIT = 200;

/** Query filters for schedule pickers/labels — fetch the full set, not a page. */
export function schedulePickerFilters(): { limit: number } {
  return { limit: SCHEDULE_PICKER_LIMIT };
}

export function schedulePageActionPermissions(permissions: readonly Permission[]) {
  return {
    canRead: permissions.includes("schedule:read"),
    canReadAudit: permissions.includes("audit:read"),
    canReadNodes: permissions.includes("node:read"),
    canManage: permissions.includes("schedule:manage"),
  } satisfies SchedulePageActionPermissions;
}

export function scheduleActionState(
  schedule: ScheduleSummary,
  permissions: SchedulePageActionPermissions,
): ScheduleActionState {
  return {
    canDelete: permissions.canManage,
    canEdit: permissions.canManage,
    canRunNow: permissions.canManage && schedule.enabled,
    canSkipNext: permissions.canManage && schedule.enabled && Boolean(schedule.nextRunAt),
  };
}

export function scheduleFiltersFromDraft(draft: SchedulePageFilterDraft): ScheduleFilters {
  return {
    captureBackend: draft.captureBackend || undefined,
    captureInterfaceId: trimmed(draft.captureInterfaceId),
    enabled: draft.enabled || undefined,
    nodeId: trimmed(draft.nodeId),
    search: trimmed(draft.search),
  };
}

export function scheduleFilterChips(filters: ScheduleFilters): ActiveScheduleFilterChip[] {
  return scheduleFilterOrder.flatMap((key) => {
    const value = filters[key];

    if (!value) {
      return [];
    }

    return [
      {
        key,
        label: scheduleFilterLabels[key],
        value: scheduleFilterValue(key, value),
      },
    ];
  });
}

function trimmed(value: string) {
  const next = value.trim();

  return next || undefined;
}

function scheduleFilterValue(key: ScheduleFilterKey, value: string) {
  return key === "enabled" ? (value === "true" ? "enabled" : "disabled") : value;
}

const scheduleFilterOrder: ScheduleFilterKey[] = [
  "search",
  "enabled",
  "nodeId",
  "captureBackend",
  "captureInterfaceId",
];

const scheduleFilterLabels: Record<ScheduleFilterKey, string> = {
  captureBackend: "backend",
  captureInterfaceId: "interface",
  enabled: "state",
  nodeId: "node",
  search: "search",
};
