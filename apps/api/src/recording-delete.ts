import type { Context } from "hono";
import { z } from "zod";

import type { AuthResult } from "./auth-service.js";
import { deleteRecordingCacheFile, recordingHasCachedFile } from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import type { AppBindings, RecordAuditEvent } from "./http-types.js";
import { uniqueRecordingIds } from "./recording-metadata.js";
import type { RecordingSummary } from "@rakkr/shared";

interface DeleteRecordingDependencies {
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
}

type DeleteRecordingsDependencies = DeleteRecordingDependencies;

const bulkDeleteRequestSchema = z
  .object({
    recordingIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
  })
  .strict();

export async function deleteRecording(
  c: Context<AppBindings>,
  {
    currentAuth,
    currentUser,
    recordAuditEvent,
    recordingStore,
    scopedRecordings,
  }: DeleteRecordingDependencies,
) {
  const recordingId = c.req.param("recordingId") ?? "";
  const recording = (await scopedRecordings(currentUser(c))).find(
    (candidate) => candidate.id === recordingId,
  );

  async function recordFailure(reason: string, targetName?: string) {
    await recordAuditEvent(c, {
      action: "recordings.delete.failed",
      auth: currentAuth(c),
      outcome: "failed",
      permission: "recording:delete",
      reason,
      target: {
        id: recordingId,
        name: targetName,
        type: "recording",
      },
    });
  }

  if (!recording) {
    await recordFailure("recording_not_found");
    return c.json({ error: "Recording not found" }, 404);
  }

  if (recording.status === "queued" || recording.status === "recording") {
    await recordFailure("recording_active", recording.name);
    return c.json({ error: "Active recordings cannot be deleted" }, 409);
  }

  const hadCachedFile = recordingHasCachedFile(recording);
  const result = await deleteRecordingData(recordingStore, recording).catch(async (error) => {
    await recordFailure(
      error instanceof Error ? error.message : "recording_cache_delete_failed",
      recording.name,
    );

    return undefined;
  });

  if (!result) {
    return c.json({ error: "Recording cache file could not be deleted" }, 409);
  }

  await recordAuditEvent(c, {
    action: "recordings.delete.succeeded",
    auth: currentAuth(c),
    before: { recording },
    details: {
      cacheDeleted: result.cacheDeleted,
      cached: hadCachedFile,
      source: recording.source,
      status: recording.status,
    },
    outcome: "succeeded",
    permission: "recording:delete",
    target: {
      id: recording.id,
      name: recording.name,
      type: "recording",
    },
  });

  return c.body(null, 204);
}

export async function deleteRecordings(
  c: Context<AppBindings>,
  {
    currentAuth,
    currentUser,
    recordAuditEvent,
    recordingStore,
    scopedRecordings,
  }: DeleteRecordingsDependencies,
) {
  const body = bulkDeleteRequestSchema.safeParse(await c.req.json().catch(() => ({})));

  async function recordFailure(
    reason: string,
    details: Record<string, unknown> = {},
    outcome: "denied" | "failed" | "partial" = "failed",
  ) {
    await recordAuditEvent(c, {
      action: "recordings.bulk_delete.failed",
      auth: currentAuth(c),
      details,
      outcome,
      permission: "recording:delete",
      reason,
      target: {
        id: "recording_collection",
        type: "recording_collection",
      },
    });
  }

  if (!body.success) {
    await recordFailure("invalid_request");
    return c.json({ error: "Invalid recording bulk delete", issues: body.error.issues }, 400);
  }

  const recordingIds = uniqueRecordingIds(body.data.recordingIds);
  const visibleIds = new Set((await scopedRecordings(currentUser(c))).map((item) => item.id));
  const hiddenIds = recordingIds.filter((recordingId) => !visibleIds.has(recordingId));

  if (hiddenIds.length > 0) {
    await recordFailure("recording_not_visible", { hiddenIds, recordingIds }, "denied");
    return c.json({ error: "One or more recordings are not visible" }, 404);
  }

  const recordings = await recordingsById(recordingStore, recordingIds);

  if (recordings.length !== recordingIds.length) {
    await recordFailure("recording_not_found", { recordingIds });
    return c.json({ error: "One or more recordings were not found" }, 404);
  }

  const activeIds = recordings
    .filter((recording) => recording.status === "queued" || recording.status === "recording")
    .map((recording) => recording.id);

  if (activeIds.length > 0) {
    await recordFailure("recording_active", { activeIds, recordingIds });
    return c.json({ error: "Active recordings cannot be deleted" }, 409);
  }

  const deleted: RecordingSummary[] = [];
  let cacheDeletedCount = 0;

  for (const recording of recordings) {
    try {
      const result = await deleteRecordingData(recordingStore, recording);

      deleted.push(recording);
      cacheDeletedCount += result.cacheDeleted ? 1 : 0;
    } catch (error) {
      await recordFailure(
        error instanceof Error ? error.message : "recording_cache_delete_failed",
        {
          cacheDeletedCount,
          deletedIds: deleted.map((item) => item.id),
          failedRecordingId: recording.id,
          recordingIds,
        },
        deleted.length > 0 ? "partial" : "failed",
      );

      return c.json({ error: "Recording cache file could not be deleted" }, 409);
    }
  }

  await recordAuditEvent(c, {
    action: "recordings.bulk_delete.succeeded",
    auth: currentAuth(c),
    before: { recordings: deleted },
    correlationIds: Object.fromEntries(
      recordingIds.map((recordingId, index) => [`recordingId${index + 1}`, recordingId]),
    ),
    details: {
      cacheDeletedCount,
      requestedCount: body.data.recordingIds.length,
      deletedCount: deleted.length,
    },
    outcome: "succeeded",
    permission: "recording:delete",
    target: {
      id: "recording_collection",
      type: "recording_collection",
    },
  });

  return c.json({ data: deleted, meta: { cacheDeletedCount, deletedCount: deleted.length } });
}

async function recordingsById(recordingStore: RecordingStore, recordingIds: string[]) {
  const recordings = await Promise.all(
    recordingIds.map((recordingId) => recordingStore.find(recordingId)),
  );

  return recordings.filter((recording): recording is RecordingSummary => Boolean(recording));
}

async function deleteRecordingData(recordingStore: RecordingStore, recording: RecordingSummary) {
  const cacheDeleted = recordingHasCachedFile(recording)
    ? await deleteRecordingCacheFile(recording)
    : false;

  await recordingStore.delete(recording.id);

  return { cacheDeleted };
}
