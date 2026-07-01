import type { Context, Hono } from "hono";
import type { RecordingSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import {
  applyRecordingBulkMetadataUpdate,
  applyRecordingMetadataUpdate,
  bulkMetadataFields,
  recordingBulkMetadataUpdateSchema,
  recordingMetadataSnapshot,
  recordingMetadataUpdateSchema,
  uniqueRecordingIds,
} from "./recording-metadata.js";
import type { RecordingStore } from "./recording-store.js";

interface RecordingMetadataRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
}

const METADATA_COMMIT_ATTEMPTS = 5;

/**
 * Persist a metadata edit without making a status/cache decision. Overlay the
 * edited fields onto the freshly-read canonical row and commit through the
 * status compare-and-set, so a concurrent writer that secured the recording
 * (status/cachePath/checksum) between our read and write neither loses its
 * change nor has it reverted by this request's stale snapshot. A plain
 * `find` + `save` only narrows that window — `save` is an unconditional
 * full-column upsert, so a secure landing between the read and the write is
 * still clobbered. If the CAS is lost (status moved under us), re-read and
 * re-overlay: a metadata edit must still land regardless of the new status.
 * Returns `undefined` when the CAS is lost on every attempt (pathological
 * contention) so the caller can report a conflict rather than a false success —
 * unlike derived health status, an operator's metadata edit does not self-heal.
 */
async function commitRecordingMetadata(
  recordingStore: RecordingStore,
  recordingId: string,
  overlay: (current: RecordingSummary) => RecordingSummary,
  fallback: RecordingSummary,
): Promise<RecordingSummary | undefined> {
  for (let attempt = 0; attempt < METADATA_COMMIT_ATTEMPTS; attempt += 1) {
    const current = await recordingStore.find(recordingId);

    if (!current) {
      // No canonical row (unpersisted/in-memory-only recording): the scoped
      // snapshot is all we have, and there is no concurrent row to clobber.
      await recordingStore.save(fallback);
      return fallback;
    }

    const persisted = overlay(current);
    const committed = await recordingStore.transition(persisted, [current.status]);

    if (committed) {
      return committed;
    }
  }

  // Every CAS round lost to a concurrent status change. Do NOT fall back to a
  // full-row save (it would reintroduce the clobber this guards against) and do
  // NOT report success — signal contention so the caller can 409 / skip.
  return undefined;
}

export function registerRecordingMetadataRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scopedRecordings,
}: RecordingMetadataRouteDependencies) {
  async function findScopedRecording(c: Context<AppBindings>, recordingId: string) {
    return (await scopedRecordings(currentUser(c))).find(
      (recording) => recording.id === recordingId,
    );
  }

  async function recordBulkMetadataFailure(
    c: Context<AppBindings>,
    reason: string,
    details: Record<string, unknown> = {},
  ) {
    await recordAuditEvent(c, {
      action: "recordings.metadata.bulk_update.failed",
      auth: currentAuth(c),
      details,
      outcome: reason === "recording_not_visible" ? "denied" : "failed",
      permission: "recording:edit",
      reason,
      target: {
        id: "recording_collection",
        type: "recording_collection",
      },
    });
  }

  app.patch(
    "/api/v1/recordings/bulk-metadata",
    requirePermission("recording:edit", "recordings.metadata.bulk_update", () => ({
      id: "recording_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const body = recordingBulkMetadataUpdateSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );

      if (!body.success) {
        await recordBulkMetadataFailure(c, "invalid_request");
        return c.json({ error: "Invalid recording bulk metadata", issues: body.error.issues }, 400);
      }

      const recordingIds = uniqueRecordingIds(body.data.recordingIds);
      const visibleRecordingMap = new Map(
        (await scopedRecordings(currentUser(c))).map((recording) => [recording.id, recording]),
      );
      const hiddenIds = recordingIds.filter((recordingId) => !visibleRecordingMap.has(recordingId));

      if (hiddenIds.length > 0) {
        await recordBulkMetadataFailure(c, "recording_not_visible", { hiddenIds, recordingIds });
        return c.json({ error: "One or more recordings are not visible" }, 404);
      }

      const updates: RecordingSummary[] = [];
      const before = [];
      const after = [];

      for (const recordingId of recordingIds) {
        const recording = visibleRecordingMap.get(recordingId)!;
        const updated = applyRecordingBulkMetadataUpdate(recording, body.data);
        // Commit through the status CAS so a concurrent upload's status/cache
        // isn't clobbered (see the single route); scoped context drives folder/tags.
        const persisted = await commitRecordingMetadata(
          recordingStore,
          recordingId,
          (current) => ({ ...current, folder: updated.folder, tags: updated.tags }),
          updated,
        );

        // Skip a recording whose CAS lost to concurrent contention: don't audit
        // it as updated or return it (no false success; self-heals on retry).
        if (!persisted) {
          continue;
        }

        before.push({ id: recording.id, ...recordingMetadataSnapshot(recording) });
        after.push({ id: updated.id, ...recordingMetadataSnapshot(updated) });
        updates.push(persisted);
      }

      await recordAuditEvent(c, {
        action: "recordings.metadata.bulk_update.succeeded",
        after: { recordings: after },
        auth: currentAuth(c),
        before: { recordings: before },
        correlationIds: Object.fromEntries(
          recordingIds.map((recordingId, index) => [`recordingId${index + 1}`, recordingId]),
        ),
        details: {
          fields: bulkMetadataFields(body.data),
          requestedCount: body.data.recordingIds.length,
          updatedCount: updates.length,
        },
        outcome: "succeeded",
        permission: "recording:edit",
        target: {
          id: "recording_collection",
          type: "recording_collection",
        },
      });

      return c.json({ data: updates, meta: { updatedCount: updates.length } });
    },
  );

  app.patch(
    "/api/v1/recordings/:recordingId/metadata",
    requirePermission("recording:edit", "recordings.metadata.update", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const body = recordingMetadataUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordAuditEvent(c, {
          action: "recordings.metadata.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "recording:edit",
          reason: "invalid_request",
          target: {
            id: recordingId,
            type: "recording",
          },
        });

        return c.json({ error: "Invalid recording metadata", issues: body.error.issues }, 400);
      }

      const recording = await findScopedRecording(c, recordingId);

      if (!recording) {
        await recordAuditEvent(c, {
          action: "recordings.metadata.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "recording:edit",
          reason: "recording_not_found",
          target: {
            id: recordingId,
            type: "recording",
          },
        });

        return c.json({ error: "Recording not found" }, 404);
      }

      const before = recordingMetadataSnapshot(recording);
      const updated = applyRecordingMetadataUpdate(recording, body.data);
      // Commit through the status CAS so a concurrent upload that secured the
      // recording between our read and write isn't reverted; scoped context
      // still drives the metadata values + audit.
      const persisted = await commitRecordingMetadata(
        recordingStore,
        recording.id,
        (current) => ({
          ...current,
          folder: updated.folder,
          name: updated.name,
          notes: updated.notes,
          tags: updated.tags,
          transcriptSnippets: updated.transcriptSnippets,
        }),
        updated,
      );

      if (!persisted) {
        // The status CAS lost to concurrent contention on every attempt; the
        // edit was not applied. Report a conflict instead of a false success so
        // the audit log stays truthful and the operator knows to retry.
        await recordAuditEvent(c, {
          action: "recordings.metadata.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "recording:edit",
          reason: "commit_contended",
          target: {
            id: recordingId,
            type: "recording",
          },
        });

        return c.json({ error: "Recording was concurrently modified; retry" }, 409);
      }

      await recordAuditEvent(c, {
        action: "recordings.metadata.update.succeeded",
        after: recordingMetadataSnapshot(updated),
        auth: currentAuth(c),
        before,
        details: {
          fields: Object.keys(body.data),
        },
        outcome: "succeeded",
        permission: "recording:edit",
        target: {
          id: updated.id,
          name: updated.name,
          type: "recording",
        },
      });

      return c.json({ data: persisted });
    },
  );
}
