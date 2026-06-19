import type {
  HealthEvent,
  RecordingSummary,
  RecordingWaveformPreview,
  UploadQueueItem,
} from "@rakkr/shared";

import type {
  RecordingFileBlob,
  RecordingFilters,
  RecordingPlaybackSession,
  RecordingSortBy,
  RecordingSortOrder,
} from "@/lib/api";
import { formatDateTime, localDateBoundaryIso } from "@/lib/dates";

export interface DownloadableRecordingFile {
  blob: Blob;
  fileName: string;
}

export interface RecordingFilterDraft {
  folder: string;
  healthStatus: "" | RecordingSummary["healthStatus"];
  nodeId: string;
  recordedFromDate: string;
  recordedToDate: string;
  recordingProfileId: string;
  scheduleId: string;
  search: string;
  sortBy: "" | RecordingSortBy;
  sortOrder: RecordingSortOrder;
  status: "" | RecordingSummary["status"];
  tag: string;
  trackGroupId: string;
  uploadPolicyId: string;
}

export type RecordingFilterKey = Exclude<keyof RecordingFilters, "limit" | "offset" | "sortOrder">;

export interface ActiveRecordingFilterChip {
  key: RecordingFilterKey;
  label: string;
  value: string;
}

export interface RecordingPlaybackPreview {
  fileName: string;
  objectUrl: string;
  recordingId: string;
  sessionId: string;
  startedAt: string;
}

type RevokeObjectUrl = (url: string) => void;

export const emptyRecordingFilterDraft: RecordingFilterDraft = {
  folder: "",
  healthStatus: "",
  nodeId: "",
  recordedFromDate: "",
  recordedToDate: "",
  recordingProfileId: "",
  scheduleId: "",
  search: "",
  sortBy: "",
  sortOrder: "desc",
  status: "",
  tag: "",
  trackGroupId: "",
  uploadPolicyId: "",
};

export const healthStatuses: Array<RecordingSummary["healthStatus"]> = [
  "healthy",
  "warning",
  "critical",
  "unknown",
];
export const recordingStatuses: Array<RecordingSummary["status"]> = [
  "queued",
  "recording",
  "completed",
  "failed",
  "cached",
  "uploaded",
];
export const recordingSortOptions: Array<{ label: string; value: RecordingSortBy }> = [
  { label: "Date", value: "recordedAt" },
  { label: "Name", value: "name" },
  { label: "Folder", value: "folder" },
  { label: "Duration", value: "durationSeconds" },
  { label: "Status", value: "status" },
  { label: "Health", value: "healthStatus" },
  { label: "Source", value: "source" },
];
export const recordingSortOrders: Array<{ label: string; value: RecordingSortOrder }> = [
  { label: "Descending", value: "desc" },
  { label: "Ascending", value: "asc" },
];
export const recordingPageSizes = [10, 25, 50, 100];
export const defaultRecordingPageSize = 25;
export const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export const recordingFilterDraftKeys: Record<RecordingFilterKey, keyof RecordingFilterDraft> = {
  folder: "folder",
  healthStatus: "healthStatus",
  nodeId: "nodeId",
  recordedFrom: "recordedFromDate",
  recordedTo: "recordedToDate",
  recordingProfileId: "recordingProfileId",
  scheduleId: "scheduleId",
  search: "search",
  sortBy: "sortBy",
  status: "status",
  tag: "tag",
  trackGroupId: "trackGroupId",
  uploadPolicyId: "uploadPolicyId",
};

const recordingFilterLabels: Record<RecordingFilterKey, string> = {
  folder: "folder",
  healthStatus: "health",
  nodeId: "node",
  recordedFrom: "from",
  recordedTo: "to",
  recordingProfileId: "profile",
  scheduleId: "schedule",
  search: "search",
  sortBy: "sort",
  status: "status",
  tag: "tag",
  trackGroupId: "track group",
  uploadPolicyId: "upload",
};

const recordingFilterOrder: RecordingFilterKey[] = [
  "search",
  "folder",
  "tag",
  "nodeId",
  "scheduleId",
  "trackGroupId",
  "recordingProfileId",
  "uploadPolicyId",
  "sortBy",
  "status",
  "healthStatus",
  "recordedFrom",
  "recordedTo",
];

export function downloadBlob(file: DownloadableRecordingFile) {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = file.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function playbackPreviewFromSession(
  session: RecordingPlaybackSession,
  file: RecordingFileBlob,
  objectUrl: string,
): RecordingPlaybackPreview {
  return {
    fileName: file.fileName,
    objectUrl,
    recordingId: session.recordingId,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
  };
}

export function replacePlaybackPreview(
  current: RecordingPlaybackPreview | undefined,
  next: RecordingPlaybackPreview,
  revokeObjectUrl: RevokeObjectUrl = URL.revokeObjectURL,
) {
  if (current && current.objectUrl !== next.objectUrl) {
    revokeObjectUrl(current.objectUrl);
  }

  return next;
}

export function clearPlaybackPreview(
  current: RecordingPlaybackPreview | undefined,
  revokeObjectUrl: RevokeObjectUrl = URL.revokeObjectURL,
) {
  if (current) {
    revokeObjectUrl(current.objectUrl);
  }

  return undefined;
}

export function waveformBarHeightPercent(peak: number) {
  const clamped = Math.min(1, Math.max(0, peak));

  return `${Math.max(10, Math.round(clamped * 100))}%`;
}

export function waveformPreviewSummary(waveform: RecordingWaveformPreview) {
  const source = waveform.source === "ffmpeg_decoded_peak" ? "decoded" : "wav";

  return `${waveform.peaks.length} peaks · ${waveform.channelCount} ch · ${waveform.sampleRate} Hz · ${source}`;
}

export function groupHealthEventsByRecording(events: HealthEvent[]) {
  const grouped = new Map<string, HealthEvent[]>();

  for (const event of events) {
    if (!event.recordingId) {
      continue;
    }

    grouped.set(event.recordingId, [...(grouped.get(event.recordingId) ?? []), event]);
  }

  return grouped;
}

export function groupUploadItemsByRecording(items: UploadQueueItem[]) {
  const grouped = new Map<string, UploadQueueItem[]>();

  for (const item of items) {
    grouped.set(item.recordingId, [...(grouped.get(item.recordingId) ?? []), item]);
  }

  return grouped;
}

export function isTerminalRecording(recording: RecordingSummary) {
  return recording.status !== "queued" && recording.status !== "recording";
}

export function isCachedRecording(recording: RecordingSummary) {
  return (
    Boolean(recording.cachePath) &&
    (recording.cached || recording.status === "cached" || recording.status === "uploaded")
  );
}

export function filtersFromDraft(draft: RecordingFilterDraft): RecordingFilters {
  return {
    folder: textOrUndefined(draft.folder),
    healthStatus: draft.healthStatus || undefined,
    nodeId: textOrUndefined(draft.nodeId),
    recordedFrom: localDateBoundaryIso(draft.recordedFromDate, "start"),
    recordedTo: localDateBoundaryIso(draft.recordedToDate, "end"),
    recordingProfileId: textOrUndefined(draft.recordingProfileId),
    scheduleId: textOrUndefined(draft.scheduleId),
    search: textOrUndefined(draft.search),
    sortBy: draft.sortBy || undefined,
    sortOrder: draft.sortBy ? draft.sortOrder : undefined,
    status: draft.status || undefined,
    tag: textOrUndefined(draft.tag),
    trackGroupId: textOrUndefined(draft.trackGroupId),
    uploadPolicyId: textOrUndefined(draft.uploadPolicyId),
  };
}

export function recordingFilterChips(filters: RecordingFilters): ActiveRecordingFilterChip[] {
  return recordingFilterOrder.flatMap((key) => {
    const value = filters[key];

    if (!value) {
      return [];
    }

    return [
      {
        key,
        label: recordingFilterLabels[key],
        value:
          key === "sortBy"
            ? `${sortFilterLabel(value, "sort")} ${sortOrderFilterLabel(filters.sortOrder)}`
            : recordingFilterValue(key, value),
      },
    ];
  });
}

function recordingFilterValue(key: RecordingFilterKey, value: string) {
  if (key === "recordedFrom" || key === "recordedTo") {
    return formatDateTime(value);
  }

  if (key === "sortBy") {
    return sortFilterLabel(value, "sort");
  }

  return value;
}

function sortFilterLabel(value: string, fallback: string) {
  return recordingSortOptions.find((option) => option.value === value)?.label ?? fallback;
}

function sortOrderFilterLabel(value: RecordingFilters["sortOrder"]) {
  return value === "asc" ? "ascending" : "descending";
}

function textOrUndefined(value: string) {
  const trimmed = value.trim();

  return trimmed || undefined;
}
