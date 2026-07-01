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
        // Overlay only the edited metadata (folder/tags) onto the freshly-read
        // canonical row so a concurrent upload's status/cache isn't clobbered
        // (see the single route); scoped context still drives folder/tags.
        const current = await recordingStore.find(recordingId);
        const persisted = current
          ? { ...current, folder: updated.folder, tags: updated.tags }
          : updated;

        before.push({ id: recording.id, ...recordingMetadataSnapshot(recording) });
        after.push({ id: updated.id, ...recordingMetadataSnapshot(updated) });
        await recordingStore.save(persisted);
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
      // A metadata edit must never carry a status/cache decision: overlay only
      // the edited metadata fields onto the freshly-read canonical row, so a
      // concurrent upload that just secured the recording (status/cachePath/
      // checksum) isn't reverted by this request's stale snapshot. Scoped context
      // still drives the metadata values + audit.
      const current = await recordingStore.find(recording.id);
      const persisted = current
        ? {
            ...current,
            folder: updated.folder,
            name: updated.name,
            notes: updated.notes,
            tags: updated.tags,
            transcriptSnippets: updated.transcriptSnippets,
          }
        : updated;

      await recordingStore.save(persisted);

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
