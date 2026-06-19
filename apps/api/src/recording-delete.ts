import type { Context } from "hono";

import type { AuthResult } from "./auth-service.js";
import { deleteRecordingCacheFile, recordingHasCachedFile } from "./recording-cache.js";
import type { RecordingStore } from "./recording-store.js";
import type { AppBindings, RecordAuditEvent } from "./http-types.js";

interface DeleteRecordingDependencies {
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
}

export async function deleteRecording(
  c: Context<AppBindings>,
  { currentAuth, recordAuditEvent, recordingStore }: DeleteRecordingDependencies,
) {
  const recordingId = c.req.param("recordingId") ?? "";
  const recording = await recordingStore.find(recordingId);

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
  let cacheDeleted = false;

  if (hadCachedFile) {
    try {
      cacheDeleted = await deleteRecordingCacheFile(recording);
    } catch (error) {
      await recordFailure(
        error instanceof Error ? error.message : "recording_cache_delete_failed",
        recording.name,
      );

      return c.json({ error: "Recording cache file could not be deleted" }, 409);
    }
  }

  await recordingStore.delete(recording.id);

  await recordAuditEvent(c, {
    action: "recordings.delete.succeeded",
    auth: currentAuth(c),
    before: { recording },
    details: {
      cacheDeleted,
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
