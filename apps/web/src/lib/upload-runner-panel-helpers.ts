import type { CurrentUser, UploadProvider, UploadQueueStatus } from "@rakkr/shared";

import type { UploadQueueFilters } from "@/lib/api";

export type UploadQueueFilterKey = keyof UploadQueueFilters;

export interface ActiveUploadQueueFilterChip {
  key: UploadQueueFilterKey;
  label: string;
  value: string;
}

export interface UploadQueueFilterDraft {
  provider: "" | UploadProvider;
  recordingId: string;
  status: "" | UploadQueueStatus;
}

export const emptyUploadQueueFilterDraft: UploadQueueFilterDraft = {
  provider: "",
  recordingId: "",
  status: "",
};

export function uploadRunnerPanelPermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canRead: permissions.includes("recording:read"),
    canRun: permissions.includes("recording:control"),
  };
}

export function uploadQueueFiltersFromDraft(draft: UploadQueueFilterDraft): UploadQueueFilters {
  return {
    provider: draft.provider || undefined,
    recordingId: trimmed(draft.recordingId),
    status: draft.status || undefined,
  };
}

export function uploadQueueFilterChips(filters: UploadQueueFilters): ActiveUploadQueueFilterChip[] {
  return uploadQueueFilterOrder.flatMap((key) => {
    const value = filters[key];

    if (!value) {
      return [];
    }

    return [
      {
        key,
        label: uploadQueueFilterLabels[key],
        value,
      },
    ];
  });
}

function trimmed(value: string) {
  const next = value.trim();

  return next || undefined;
}

const uploadQueueFilterOrder: UploadQueueFilterKey[] = ["status", "provider", "recordingId"];

const uploadQueueFilterLabels: Record<UploadQueueFilterKey, string> = {
  provider: "provider",
  recordingId: "recording",
  status: "status",
};
