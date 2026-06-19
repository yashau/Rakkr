import { z } from "zod";
import { type RecordingSummary, recordingStatusSchema } from "@rakkr/shared";

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

export const recordingsQuerySchema = z.object({
  folder: optionalTextFilterSchema,
  healthStatus: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.enum(["healthy", "warning", "critical", "unknown"]).optional(),
  ),
  nodeId: optionalTextFilterSchema,
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

export function filterRecordings(recordings: RecordingSummary[], filters: RecordingsQuery) {
  const filtered = recordings.filter((recording) => {
    if (filters.folder && !includesText(recording.folder, filters.folder)) {
      return false;
    }

    if (filters.healthStatus && recording.healthStatus !== filters.healthStatus) {
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

    if (filters.uploadPolicyId && recording.uploadPolicyId !== filters.uploadPolicyId) {
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
  const tags = new Map<string, number>();

  for (const recording of recordings) {
    folders.set(recording.folder, (folders.get(recording.folder) ?? 0) + 1);

    for (const tag of recording.tags) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
  }

  return {
    folders: sortedFacets(folders),
    tags: sortedFacets(tags),
  };
}

function recordingMatchesSearch(recording: RecordingSummary, search: string) {
  const searchableValues = [
    recording.folder,
    recording.id,
    recording.name,
    recording.nodeId,
    recording.recordingProfileId,
    recording.scheduleId,
    recording.source,
    recording.status,
    recording.trackGroupId,
    recording.uploadPolicyId,
    ...recording.tags,
  ];

  return searchableValues.some((value) => value && includesText(value, search));
}

function sortedFacets(values: Map<string, number>) {
  return [...values.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function includesText(value: string, search: string) {
  return value.toLocaleLowerCase().includes(search.toLocaleLowerCase());
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
