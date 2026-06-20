import { z } from "zod";
import type { RecordingSummary } from "@rakkr/shared";

const tagsSchema = z.array(z.string().trim().min(1).max(48)).max(32);
const transcriptSnippetsSchema = z.array(z.string().trim().min(1).max(500)).max(20);

export const recordingMetadataUpdateSchema = z
  .object({
    folder: z.string().trim().min(1).max(240).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    tags: tagsSchema.optional(),
    transcriptSnippets: transcriptSnippetsSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.folder !== undefined ||
      value.name !== undefined ||
      value.notes !== undefined ||
      value.tags !== undefined ||
      value.transcriptSnippets !== undefined,
    "Expected at least one metadata field",
  );

export const recordingBulkMetadataUpdateSchema = z
  .object({
    addTags: tagsSchema.optional(),
    folder: z.string().trim().min(1).max(240).optional(),
    recordingIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
    removeTags: tagsSchema.optional(),
    replaceTags: tagsSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.folder !== undefined ||
      value.addTags !== undefined ||
      value.removeTags !== undefined ||
      value.replaceTags !== undefined,
    "Expected at least one metadata field",
  )
  .refine(
    (value) =>
      value.replaceTags === undefined ||
      (value.addTags === undefined && value.removeTags === undefined),
    "replaceTags cannot be combined with addTags or removeTags",
  );

type MetadataUpdate = z.infer<typeof recordingMetadataUpdateSchema>;
type BulkMetadataUpdate = z.infer<typeof recordingBulkMetadataUpdateSchema>;

export function applyRecordingMetadataUpdate(
  recording: RecordingSummary,
  update: MetadataUpdate,
): RecordingSummary {
  return {
    ...recording,
    folder: update.folder ?? recording.folder,
    name: update.name ?? recording.name,
    notes: update.notes === undefined ? recording.notes : update.notes || undefined,
    tags: update.tags ? uniqueTags(update.tags) : recording.tags,
    transcriptSnippets:
      update.transcriptSnippets === undefined
        ? recording.transcriptSnippets
        : uniqueTranscriptSnippets(update.transcriptSnippets),
  };
}

export function applyRecordingBulkMetadataUpdate(
  recording: RecordingSummary,
  update: BulkMetadataUpdate,
): RecordingSummary {
  return {
    ...recording,
    folder: update.folder ?? recording.folder,
    tags: bulkTags(recording.tags, update),
  };
}

export function bulkMetadataFields(update: BulkMetadataUpdate) {
  return ["folder", "addTags", "removeTags", "replaceTags"].filter(
    (field) => update[field as keyof BulkMetadataUpdate] !== undefined,
  );
}

export function recordingMetadataSnapshot(recording: RecordingSummary) {
  return {
    folder: recording.folder,
    name: recording.name,
    notes: recording.notes,
    tags: recording.tags,
    transcriptSnippets: recording.transcriptSnippets,
  };
}

export function uniqueRecordingIds(recordingIds: string[]) {
  return [...new Set(recordingIds)];
}

export function uniqueTags(tags: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    const key = tagKey(tag);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }

  return result;
}

function bulkTags(tags: string[], update: BulkMetadataUpdate) {
  if (update.replaceTags) {
    return uniqueTags(update.replaceTags);
  }

  const removed = new Set((update.removeTags ?? []).map(tagKey));
  const kept = tags.filter((tag) => !removed.has(tagKey(tag)));

  return uniqueTags([...kept, ...(update.addTags ?? [])]);
}

function uniqueTranscriptSnippets(snippets: string[] | null) {
  if (!snippets) {
    return undefined;
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const snippet of snippets) {
    const key = snippetKey(snippet);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(snippet);
    }
  }

  return result.length > 0 ? result : undefined;
}

function tagKey(tag: string) {
  return tag.toLocaleLowerCase();
}

function snippetKey(snippet: string) {
  return snippet.toLocaleLowerCase();
}
