import type {
  CurrentUser,
  HealthEvent,
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
  RecordingWaveformPreview,
  ScheduleSummary,
  UploadPolicy,
  UploadQueueItem,
  UploadQueueStatus,
} from "@rakkr/shared";

import type {
  RecordingFileBlob,
  RecordingFilters,
  RecordingCacheState,
  RecordingPlaybackSession,
  RecordingSortBy,
  RecordingSortOrder,
} from "@/lib/api";
import { formatDateTime, localDateBoundaryIso } from "@/lib/dates";

/**
 * Query keys to invalidate after an operator upload-queue action that is
 * audited server-side (single enqueue, bulk enqueue, retry). Each of these
 * records an audit event, so the audit view must refresh alongside the upload
 * queue; otherwise the on-screen audit log stays stale until an unrelated
 * refetch. Single-enqueue and retry previously invalidated only the queue and
 * left the audit view stale (G78) — the bulk path already refreshed both.
 */
export const auditedUploadActionQueryKeys: readonly (readonly string[])[] = [
  ["audit-events"],
  ["upload-queue"],
];

/**
 * Page size for the recordings-page cross-reference fetches (recording jobs and
 * upload-queue items) that are grouped by recording onto each card. With the
 * default page size (50) a recording's jobs/uploads fall off the fetched page
 * once the system holds more than 50 of them, so the card renders empty even
 * though jobs exist (G77) — the sibling health-events fetch already requests a
 * large page. 200 is the API's max page size (PAGE_POLICY.default.maxLimit).
 * This still fetches a global page rather than one scoped to the visible
 * recordings, so a complete fix needs a recording-scoped job/upload filter
 * (tracked).
 */
export const recordingCrossReferenceLimit = 200;

export interface DownloadableRecordingFile {
  blob: Blob;
  fileName: string;
}

export interface RecordingFilterDraft {
  cacheState: "" | RecordingCacheState;
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

export type RecordingRendition = "enhanced" | "raw";

export interface RecordingPlaybackPreview {
  fileName: string;
  objectUrl: string;
  recordingId: string;
  rendition: RecordingRendition;
  sessionId: string;
  startedAt: string;
}

export interface RecordingFileActionState {
  canDownload: boolean;
  canPlayback: boolean;
  fileReady: boolean;
}

export interface UploadQueueStatusCount {
  count: number;
  status: UploadQueueStatus;
}

export interface RecordingPagePermissions {
  canControlRecordings: boolean;
  canCreateRecordings: boolean;
  canDeleteRecordings: boolean;
  canDownloadRecordings: boolean;
  canEditRecordings: boolean;
  canPlaybackRecordings: boolean;
  canReadHealth: boolean;
  canReadNodes: boolean;
  canReadRecordings: boolean;
  canReadSchedules: boolean;
  canReadSettings: boolean;
}

export interface RecordingRelationshipReferences {
  nodes?: RecorderNode[];
  recordingProfiles?: RecordingProfile[];
  schedules?: ScheduleSummary[];
  uploadPolicies?: UploadPolicy[];
}

type RevokeObjectUrl = (url: string) => void;

export const emptyRecordingFilterDraft: RecordingFilterDraft = {
  cacheState: "",
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
  "partial",
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

export function transcriptSnippetsFromText(value: string) {
  const seen = new Set<string>();
  const snippets: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    const key = trimmed.toLocaleLowerCase();

    if (trimmed && !seen.has(key)) {
      seen.add(key);
      snippets.push(trimmed);
    }
  }

  return snippets;
}

export function transcriptSnippetsToText(snippets: string[] | undefined) {
  return snippets?.join("\n") ?? "";
}

export function tagsToText(tags: string[]) {
  return tags.join(", ");
}

export function tagsFromText(value: string) {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const tag of value.split(",")) {
    const trimmed = tag.trim();
    const key = trimmed.toLocaleLowerCase();

    if (trimmed && !seen.has(key)) {
      seen.add(key);
      tags.push(trimmed);
    }
  }

  return tags;
}
export const recordingPageSizes = [10, 25, 50, 100];
export const recordingCacheStateOptions: Array<{ label: string; value: RecordingCacheState }> = [
  { label: "Cached", value: "cached" },
  { label: "Missing cache", value: "missing" },
];
export const uploadQueueStatusOrder: UploadQueueStatus[] = [
  "failed",
  "retrying",
  "queued",
  "succeeded",
  "cancelled",
];
export const defaultRecordingPageSize = 25;
export const selectClassName = "w-full";

export const recordingFilterDraftKeys: Record<RecordingFilterKey, keyof RecordingFilterDraft> = {
  cacheState: "cacheState",
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
  cacheState: "cache",
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
  "cacheState",
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
  rendition: RecordingRendition = "enhanced",
): RecordingPlaybackPreview {
  return {
    fileName: file.fileName,
    objectUrl,
    recordingId: session.recordingId,
    rendition,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
  };
}

// Which renditions a recording can offer in the player: a raw master alongside
// the enhanced default is available only when rawCachePath is set.
export function availableRecordingRenditions(
  recording: Pick<RecordingSummary, "enhancedCachePath" | "rawCachePath"> | undefined,
): RecordingRendition[] {
  if (recording?.rawCachePath) {
    return ["enhanced", "raw"];
  }

  return [];
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

export function recordingFileActionState(
  recording: RecordingSummary,
  permissions: { canDownload: boolean; canPlayback: boolean },
): RecordingFileActionState {
  const fileReady = isCachedRecording(recording);

  return {
    canDownload: permissions.canDownload && fileReady,
    canPlayback: permissions.canPlayback && fileReady,
    fileReady,
  };
}

export function recordingPagePermissions(user: CurrentUser | undefined): RecordingPagePermissions {
  const permissions = user?.permissions ?? [];

  return {
    canControlRecordings: permissions.includes("recording:control"),
    canCreateRecordings: permissions.includes("recording:create"),
    canDeleteRecordings: permissions.includes("recording:delete"),
    canDownloadRecordings: permissions.includes("recording:download"),
    canEditRecordings: permissions.includes("recording:edit"),
    canPlaybackRecordings: permissions.includes("recording:playback"),
    canReadHealth: permissions.includes("health:read"),
    canReadNodes: permissions.includes("node:read"),
    canReadRecordings: permissions.includes("recording:read"),
    canReadSchedules: permissions.includes("schedule:read"),
    canReadSettings: permissions.includes("settings:read"),
  };
}

export function recordingRelationshipBadges(
  recording: RecordingSummary,
  references: RecordingRelationshipReferences = {},
) {
  const items: Array<{ label: string; value: string }> = [];

  if (recording.nodeId) {
    items.push({ label: "node", value: nodeRelationshipLabel(recording.nodeId, references.nodes) });
  }

  if (recording.scheduleId) {
    const schedule = references.schedules?.find(
      (candidate) => candidate.id === recording.scheduleId,
    );

    items.push({ label: "schedule", value: schedule?.name ?? recording.scheduleId });
  }

  if (recording.recordingProfileId) {
    const profile = references.recordingProfiles?.find(
      (candidate) => candidate.id === recording.recordingProfileId,
    );

    items.push({ label: "profile", value: profile?.name ?? recording.recordingProfileId });
  }

  for (const uploadPolicyId of recording.uploadPolicyIds ?? []) {
    const policy = references.uploadPolicies?.find((candidate) => candidate.id === uploadPolicyId);

    items.push({ label: "upload", value: policy?.name ?? uploadPolicyId });
  }

  if (recording.trackIndex && recording.trackTotal) {
    items.push({ label: "track", value: `${recording.trackIndex}/${recording.trackTotal}` });
  }

  if (recording.trackGroupId) {
    items.push({ label: "group", value: recording.trackGroupId });
  }

  return items;
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

export function uploadQueueStatusSummary(
  items: UploadQueueItem[],
  visibleRecordingIds: string[],
): UploadQueueStatusCount[] {
  const visibleIds = new Set(visibleRecordingIds);
  const counts = new Map<UploadQueueStatus, number>();

  for (const item of items) {
    if (visibleIds.has(item.recordingId)) {
      counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    }
  }

  return uploadQueueStatusOrder.flatMap((status) => {
    const count = counts.get(status) ?? 0;

    return count > 0 ? [{ count, status }] : [];
  });
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
    cacheState: draft.cacheState || undefined,
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

function nodeRelationshipLabel(nodeId: string, nodes: RecorderNode[] | undefined) {
  const node = nodes?.find((candidate) => candidate.id === nodeId);

  if (!node) {
    return nodeId;
  }

  const details = [node.location.room, node.ipAddresses[0]].filter(Boolean).join(" / ");

  return details ? `${node.alias} (${details})` : node.alias;
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
