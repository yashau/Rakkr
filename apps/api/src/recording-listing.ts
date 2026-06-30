import { z } from "zod";
import { type RecordingSummary, recordingStatusSchema } from "@rakkr/shared";

import { neutralizeCsvFormula } from "./csv.js";
import { paginate } from "./pagination.js";

const optionalTextFilterSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().trim().max(240).optional(),
);
const optionalIsoFilterSchema = z
  .preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().trim().optional(),
  )
  .refine(
    (value) => value === undefined || !Number.isNaN(Date.parse(value)),
    "Expected ISO date-time",
  );
const recordingSortBySchema = z.enum([
  "durationSeconds",
  "folder",
  "healthStatus",
  "name",
  "recordedAt",
  "source",
  "status",
]);
const recordingSortOrderSchema = z.enum(["asc", "desc"]);
const recordingCacheStateSchema = z.enum(["cached", "missing"]);
const optionalPaginationNumberSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? Number(value) : undefined),
  z.number().int().nonnegative().optional(),
);

export const recordingsQuerySchema = z.object({
  cacheState: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    recordingCacheStateSchema.optional(),
  ),
  folder: optionalTextFilterSchema,
  healthStatus: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.enum(["healthy", "warning", "critical", "unknown"]).optional(),
  ),
  limit: optionalPaginationNumberSchema.refine(
    (value) => value === undefined || (value >= 1 && value <= 200),
    "Expected limit between 1 and 200",
  ),
  nodeId: optionalTextFilterSchema,
  offset: optionalPaginationNumberSchema,
  recordedFrom: optionalIsoFilterSchema,
  recordedTo: optionalIsoFilterSchema,
  recordingProfileId: optionalTextFilterSchema,
  scheduleId: optionalTextFilterSchema,
  search: optionalTextFilterSchema,
  sortBy: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    recordingSortBySchema.optional(),
  ),
  sortOrder: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    recordingSortOrderSchema.optional(),
  ),
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    recordingStatusSchema.optional(),
  ),
  tag: optionalTextFilterSchema,
  trackGroupId: optionalTextFilterSchema,
  uploadPolicyId: optionalTextFilterSchema,
});

type RecordingsQuery = z.infer<typeof recordingsQuerySchema>;

export interface RecordingPaginationMeta {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  limit?: number;
  offset: number;
  returned: number;
  total: number;
}

export function filterRecordings(recordings: RecordingSummary[], filters: RecordingsQuery) {
  const filtered = recordings.filter((recording) => {
    if (filters.folder && !includesText(recording.folder, filters.folder)) {
      return false;
    }

    if (filters.healthStatus && recording.healthStatus !== filters.healthStatus) {
      return false;
    }

    if (filters.cacheState && recordingCacheState(recording) !== filters.cacheState) {
      return false;
    }

    if (filters.nodeId && recording.nodeId !== filters.nodeId) {
      return false;
    }

    if (
      filters.recordedFrom &&
      Date.parse(recording.recordedAt) < Date.parse(filters.recordedFrom)
    ) {
      return false;
    }

    if (filters.recordedTo && Date.parse(recording.recordedAt) > Date.parse(filters.recordedTo)) {
      return false;
    }

    if (filters.recordingProfileId && recording.recordingProfileId !== filters.recordingProfileId) {
      return false;
    }

    if (filters.scheduleId && recording.scheduleId !== filters.scheduleId) {
      return false;
    }

    if (filters.search && !recordingMatchesSearch(recording, filters.search)) {
      return false;
    }

    if (filters.status && recording.status !== filters.status) {
      return false;
    }

    if (filters.trackGroupId && recording.trackGroupId !== filters.trackGroupId) {
      return false;
    }

    if (filters.uploadPolicyId && !recording.uploadPolicyIds?.includes(filters.uploadPolicyId)) {
      return false;
    }

    return (
      !filters.tag ||
      recording.tags.some((tag) => tag.toLocaleLowerCase() === filters.tag?.toLocaleLowerCase())
    );
  });

  return sortRecordings(filtered, filters);
}

export function recordingFacets(recordings: RecordingSummary[]) {
  const folders = new Map<string, number>();
  const nodes = new Map<string, number>();
  const recordingProfiles = new Map<string, number>();
  const tags = new Map<string, number>();
  const trackGroups = new Map<string, number>();
  const uploadPolicies = new Map<string, number>();

  for (const recording of recordings) {
    folders.set(recording.folder, (folders.get(recording.folder) ?? 0) + 1);
    incrementFacet(nodes, recording.nodeId);
    incrementFacet(recordingProfiles, recording.recordingProfileId);
    incrementFacet(trackGroups, recording.trackGroupId);

    for (const uploadPolicyId of recording.uploadPolicyIds ?? []) {
      incrementFacet(uploadPolicies, uploadPolicyId);
    }

    for (const tag of recording.tags) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
  }

  return {
    folders: sortedFacets(folders),
    nodes: sortedFacets(nodes),
    recordingProfiles: sortedFacets(recordingProfiles),
    tags: sortedFacets(tags),
    trackGroups: sortedFacets(trackGroups),
    uploadPolicies: sortedFacets(uploadPolicies),
  };
}

export function paginateRecordings(recordings: RecordingSummary[], filters: RecordingsQuery) {
  return paginate(recordings, { limit: filters.limit, offset: filters.offset });
}

const recordingExportHeaders = [
  "id",
  "name",
  "notes",
  "transcriptSnippets",
  "folder",
  "tags",
  "status",
  "healthStatus",
  "source",
  "recordedAt",
  "durationSeconds",
  "nodeId",
  "scheduleId",
  "recordingProfileId",
  "uploadPolicyIds",
  "watchdogPolicyId",
  "trackGroupId",
  "trackIndex",
  "trackTotal",
  "cached",
  "cachePath",
  "checksum",
] as const;

export function recordingManifestCsv(recordings: RecordingSummary[]) {
  return [
    recordingExportHeaders.join(","),
    ...recordings.map((recording) =>
      recordingExportHeaders
        .map((header) => csvCell(recordingExportValue(recording, header)))
        .join(","),
    ),
  ].join("\n");
}

function recordingExportValue(
  recording: RecordingSummary,
  header: (typeof recordingExportHeaders)[number],
) {
  if (header === "tags") {
    return recording.tags.join(";");
  }

  if (header === "transcriptSnippets") {
    return recording.transcriptSnippets?.join(" | ") ?? "";
  }

  if (header === "uploadPolicyIds") {
    return recording.uploadPolicyIds?.join(";") ?? "";
  }

  return String(recording[header] ?? "");
}

function recordingMatchesSearch(recording: RecordingSummary, search: string) {
  const searchableValues = [
    recording.folder,
    recording.id,
    recording.name,
    recording.notes,
    recording.nodeId,
    recording.recordingProfileId,
    recording.scheduleId,
    recording.source,
    recording.status,
    recording.trackGroupId,
    ...(recording.uploadPolicyIds ?? []),
    ...recording.tags,
    ...(recording.transcriptSnippets ?? []),
  ];

  return searchableValues.some((value) => value && includesText(value, search));
}

function sortedFacets(values: Map<string, number>) {
  return [...values.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function incrementFacet(values: Map<string, number>, value: string | undefined) {
  if (!value) {
    return;
  }

  values.set(value, (values.get(value) ?? 0) + 1);
}

function includesText(value: string, search: string) {
  return value.toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

function csvCell(value: string) {
  const text = neutralizeCsvFormula(value);

  if (/[",\n\r]/u.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function sortRecordings(recordings: RecordingSummary[], filters: RecordingsQuery) {
  if (!filters.sortBy) {
    return recordings;
  }

  const sortBy = filters.sortBy;
  const sortOrder = filters.sortOrder ?? defaultSortOrder(sortBy);

  return [...recordings].sort((left, right) => {
    const comparison = compareRecordingField(left, right, sortBy);
    const ordered = sortOrder === "desc" ? -comparison : comparison;

    return ordered || left.id.localeCompare(right.id);
  });
}

function defaultSortOrder(sortBy: NonNullable<RecordingsQuery["sortBy"]>) {
  return sortBy === "durationSeconds" || sortBy === "recordedAt" ? "desc" : "asc";
}

function compareRecordingField(
  left: RecordingSummary,
  right: RecordingSummary,
  sortBy: NonNullable<RecordingsQuery["sortBy"]>,
) {
  if (sortBy === "durationSeconds") {
    return left.durationSeconds - right.durationSeconds;
  }

  if (sortBy === "recordedAt") {
    return Date.parse(left.recordedAt) - Date.parse(right.recordedAt);
  }

  return String(left[sortBy]).localeCompare(String(right[sortBy]));
}

function recordingCacheState(recording: RecordingSummary) {
  return recording.cachePath &&
    (recording.cached || recording.status === "cached" || recording.status === "uploaded")
    ? "cached"
    : "missing";
}
