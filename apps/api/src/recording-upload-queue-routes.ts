import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  uploadProviderSchema,
  uploadQueueStatusSchema,
  type Permission,
  type RecordingSummary,
  type UploadQueueItem,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import { recordingHasCachedFile } from "./recording-cache.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import { uniqueRecordingIds } from "./recording-metadata.js";
import type { RecordingStore } from "./recording-store.js";
import { uploadPolicyForQueue, uploadQueueInputForPolicy } from "./upload-policies.js";
import {
  enqueueRecordingUpload,
  listUploadQueueItems,
  retryUploadQueueItem,
  uploadProviderFromValue,
} from "./upload-queue.js";

interface RecordingUploadQueueRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  recordingStore: RecordingStore;
  requirePermission: RequirePermission;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
}

const uploadQueueRequestSchema = z
  .object({
    provider: z.unknown().optional(),
    reason: z.string().trim().min(1).max(240).optional(),
    target: z.string().trim().min(1).max(500).optional(),
    uploadPolicyId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
const bulkUploadQueueRequestSchema = uploadQueueRequestSchema.extend({
  recordingIds: z.array(z.string().trim().min(1).max(160)).min(1).max(200),
});
const uploadQueueQuerySchema = z.object({
  provider: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    uploadProviderSchema.optional(),
  ),
  recordingId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    z.string().trim().min(1).max(160).optional(),
  ),
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value : undefined),
    uploadQueueStatusSchema.optional(),
  ),
});
const retryableUploadQueueStatuses = new Set<UploadQueueItem["status"]>(["cancelled", "failed"]);

interface UploadQueueActionState {
  enabled: boolean;
  href?: string;
  method: "GET" | "POST";
  permission: Permission;
  reason?: string;
}

export function registerRecordingUploadQueueRoutes({
  app,
  currentAuth,
  currentUser,
  recordAuditEvent,
  recordingStore,
  requirePermission,
  scopedRecordings,
}: RecordingUploadQueueRouteDependencies) {
  app.get(
    "/api/v1/upload-queue",
    requirePermission("recording:read", "recordings.upload_queue.read"),
    async (c) => {
      const query = uploadQueueQuerySchema.safeParse(c.req.query());

      if (!query.success) {
        return c.json({ error: "Invalid upload queue filters", issues: query.error.issues }, 400);
      }

      const visibleRecordingIds = new Set(
        (await scopedRecordings(currentUser(c))).map((recording) => recording.id),
      );
      const items = await listUploadQueueItems();

      return c.json({
        data: items.filter(
          (item) =>
            visibleRecordingIds.has(item.recordingId) && uploadQueueItemMatches(item, query.data),
        ),
      });
    },
  );

  app.get(
    "/api/v1/upload-queue/:itemId",
    requirePermission("recording:read", "recordings.upload_queue.detail.read", async (c) => {
      const itemId = c.req.param("itemId") ?? "";
      const item = await uploadQueueItem(itemId);

      return {
        id: item?.recordingId ?? itemId,
        type: item ? "recording" : "upload_queue",
      };
    }),
    async (c) => {
      const item = await visibleUploadQueueItem(c.req.param("itemId") ?? "", {
        currentUser,
        c,
        scopedRecordings,
      });

      if (!item) {
        return c.json({ error: "Upload queue item not found" }, 404);
      }

      return c.json({
        data: {
          item,
          links: uploadQueueLinks(item.id),
          recording: await recordingStore.find(item.recordingId),
        },
      });
    },
  );

  app.get(
    "/api/v1/upload-queue/:itemId/actions",
    requirePermission("recording:read", "recordings.upload_queue.actions.read", async (c) => {
      const itemId = c.req.param("itemId") ?? "";
      const item = await uploadQueueItem(itemId);

      return {
        id: item?.recordingId ?? itemId,
        type: item ? "recording" : "upload_queue",
      };
    }),
    async (c) => {
      const item = await visibleUploadQueueItem(c.req.param("itemId") ?? "", {
        currentUser,
        c,
        scopedRecordings,
      });

      if (!item) {
        return c.json({ error: "Upload queue item not found" }, 404);
      }

      const recording = await recordingStore.find(item.recordingId);

      return c.json({
        data: {
          actions: uploadQueueActions(item, currentUser(c).permissions, Boolean(recording)),
          item,
          links: uploadQueueLinks(item.id),
          recording,
        },
      });
    },
  );

  app.post(
    "/api/v1/recordings/:recordingId/upload-queue",
    requirePermission("recording:control", "recordings.upload_queue.enqueue", (c) => ({
      id: c.req.param("recordingId"),
      type: "recording",
    })),
    async (c) => {
      const recordingId = c.req.param("recordingId");
      const body = uploadQueueRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordUploadQueueFailure(c, {
          action: "recordings.upload_queue.enqueue.failed",
          currentAuth,
          reason: "invalid_request",
          recordAuditEvent,
          recordingId,
        });

        return c.json({ error: "Invalid upload queue request", issues: body.error.issues }, 400);
      }

      const result = await enqueueOne(c, recordingId, body.data, {
        currentAuth,
        recordAuditEvent,
        recordingStore,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, result.status === 404 ? 404 : 409);
      }

      return c.json({ data: result.item }, 201);
    },
  );

  app.post(
    "/api/v1/recordings/bulk-upload-queue",
    requirePermission("recording:control", "recordings.upload_queue.bulk_enqueue", () => ({
      id: "recording_collection",
      type: "recording_collection",
    })),
    async (c) => {
      const body = bulkUploadQueueRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordBulkUploadQueueFailure(c, "invalid_request", {
          currentAuth,
          recordAuditEvent,
        });

        return c.json(
          { error: "Invalid bulk upload queue request", issues: body.error.issues },
          400,
        );
      }

      const recordingIds = uniqueRecordingIds(body.data.recordingIds);
      const visibleIds = new Set(
        (await scopedRecordings(currentUser(c))).map((recording) => recording.id),
      );
      const hiddenIds = recordingIds.filter((recordingId) => !visibleIds.has(recordingId));

      if (hiddenIds.length > 0) {
        await recordBulkUploadQueueFailure(c, "recording_not_visible", {
          currentAuth,
          details: { hiddenIds, recordingIds },
          outcome: "denied",
          recordAuditEvent,
        });

        return c.json({ error: "One or more recordings are not visible" }, 404);
      }

      const recordings = await Promise.all(
        recordingIds.map((recordingId) => recordingStore.find(recordingId)),
      );
      const missingIds = recordingIds.filter((_, index) => !recordings[index]);

      if (missingIds.length > 0) {
        await recordBulkUploadQueueFailure(c, "recording_not_found", {
          currentAuth,
          details: { missingIds, recordingIds },
          recordAuditEvent,
        });

        return c.json({ error: "One or more recordings were not found" }, 404);
      }

      const cachedRecordings = recordings.filter(
        (recording): recording is RecordingSummary =>
          recording !== undefined && recordingHasCachedFile(recording),
      );

      if (cachedRecordings.length !== recordingIds.length) {
        const notCachedIds = recordingIds.filter((recordingId) => {
          const recording = recordings.find(
            (candidate): candidate is RecordingSummary =>
              candidate !== undefined && candidate.id === recordingId,
          );

          return !recording || !recordingHasCachedFile(recording);
        });

        await recordBulkUploadQueueFailure(c, "recording_not_cached", {
          currentAuth,
          details: { notCachedIds, recordingIds },
          recordAuditEvent,
        });

        return c.json({ error: "One or more recordings are not cached" }, 409);
      }

      const queueInputs = [];

      for (const recording of cachedRecordings) {
        const policy = await uploadPolicyForQueue(
          body.data.uploadPolicyId ?? recording.uploadPolicyId,
        );

        if (!policy.enabled) {
          await recordBulkUploadQueueFailure(c, "upload_policy_disabled", {
            currentAuth,
            details: { recordingId: recording.id, recordingIds, uploadPolicyId: policy.id },
            recordAuditEvent,
          });

          return c.json({ error: "Upload policy is disabled" }, 409);
        }

        queueInputs.push({
          input: {
            ...uploadQueueInputForPolicy(policy, body.data.reason),
            provider: body.data.provider
              ? uploadProviderFromValue(body.data.provider)
              : policy.provider,
            target: body.data.target ?? policy.target,
          },
          recording,
        });
      }

      const items = [];

      for (const queueInput of queueInputs) {
        items.push(await enqueueRecordingUpload(queueInput.recording, queueInput.input));
      }

      await recordAuditEvent(c, {
        action: "recordings.upload_queue.bulk_enqueue.succeeded",
        auth: currentAuth(c),
        correlationIds: Object.fromEntries(
          items.flatMap((item, index) => [
            [`recordingId${index + 1}`, item.recordingId],
            [`uploadQueueItemId${index + 1}`, item.id],
          ]),
        ),
        details: {
          providers: [...new Set(items.map((item) => item.provider))],
          queuedCount: items.length,
          requestedCount: body.data.recordingIds.length,
        },
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: "recording_collection",
          type: "recording_collection",
        },
      });

      return c.json({ data: items, meta: { queuedCount: items.length } }, 201);
    },
  );

  app.post(
    "/api/v1/upload-queue/:itemId/retry",
    requirePermission("recording:control", "recordings.upload_queue.retry", async (c) => {
      const itemId = c.req.param("itemId") ?? "";
      const item = await uploadQueueItem(itemId);

      return {
        id: item?.recordingId ?? itemId,
        type: item ? "recording" : "upload_queue",
      };
    }),
    async (c) => {
      const itemId = c.req.param("itemId");
      const item = await uploadQueueItem(itemId);

      if (!item) {
        await recordUploadQueueFailure(c, {
          action: "recordings.upload_queue.retry.failed",
          currentAuth,
          itemId,
          reason: "upload_queue_item_not_found",
          recordAuditEvent,
        });

        return c.json({ error: "Upload queue item not found" }, 404);
      }

      const visibleRecordingIds = new Set(
        (await scopedRecordings(currentUser(c))).map((recording) => recording.id),
      );

      if (!visibleRecordingIds.has(item.recordingId)) {
        await recordUploadQueueFailure(c, {
          action: "recordings.upload_queue.retry.failed",
          currentAuth,
          itemId,
          outcome: "denied",
          reason: "upload_queue_item_not_visible",
          recordAuditEvent,
          recordingId: item.recordingId,
        });

        return c.json({ error: "Upload queue item not found" }, 404);
      }

      const retried = await retryUploadQueueItem(item.id);

      if (!retried) {
        await recordUploadQueueFailure(c, {
          action: "recordings.upload_queue.retry.failed",
          currentAuth,
          itemId,
          reason: "upload_queue_item_not_found",
          recordAuditEvent,
        });

        return c.json({ error: "Upload queue item not found" }, 404);
      }

      const recording = await recordingStore.find(retried.recordingId);

      await recordAuditEvent(c, {
        action: "recordings.upload_queue.retry.succeeded",
        auth: currentAuth(c),
        correlationIds: {
          recordingId: retried.recordingId,
          uploadQueueItemId: retried.id,
        },
        details: uploadQueueAuditDetails(retried),
        outcome: "succeeded",
        permission: "recording:control",
        target: {
          id: retried.recordingId,
          name: recording?.name,
          type: "recording",
        },
      });

      return c.json({ data: retried });
    },
  );
}

async function visibleUploadQueueItem(
  itemId: string,
  {
    c,
    currentUser,
    scopedRecordings,
  }: Pick<RecordingUploadQueueRouteDependencies, "currentUser" | "scopedRecordings"> & {
    c: Context<AppBindings>;
  },
) {
  const item = await uploadQueueItem(itemId);

  if (!item) {
    return undefined;
  }

  const visibleRecordingIds = new Set(
    (await scopedRecordings(currentUser(c))).map((recording) => recording.id),
  );

  return visibleRecordingIds.has(item.recordingId) ? item : undefined;
}

function uploadQueueActions(
  item: UploadQueueItem,
  permissions: readonly Permission[],
  recordingExists: boolean,
) {
  return {
    detail: uploadQueueActionState({
      href: `/api/v1/upload-queue/${item.id}`,
      method: "GET",
      permission: "recording:read",
      permissions,
      ready: true,
    }),
    retry: uploadQueueActionState({
      href: `/api/v1/upload-queue/${item.id}/retry`,
      method: "POST",
      permission: "recording:control",
      permissions,
      ready: retryableUploadQueueStatuses.has(item.status) && recordingExists,
      reason: uploadQueueRetryBlockedReason(item, recordingExists),
    }),
  };
}

function uploadQueueActionState({
  href,
  method,
  permission,
  permissions,
  ready,
  reason,
}: {
  href: string;
  method: UploadQueueActionState["method"];
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): UploadQueueActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason };
}

function uploadQueueRetryBlockedReason(item: UploadQueueItem, recordingExists: boolean) {
  if (!retryableUploadQueueStatuses.has(item.status)) {
    return "upload_queue_item_not_retryable";
  }

  return recordingExists ? "upload_queue_item_not_retryable" : "recording_not_found";
}

function uploadQueueLinks(itemId: string) {
  return {
    detail: `/api/v1/upload-queue/${itemId}`,
    retry: `/api/v1/upload-queue/${itemId}/retry`,
  };
}

async function enqueueOne(
  c: Context<AppBindings>,
  recordingId: string,
  body: z.infer<typeof uploadQueueRequestSchema>,
  {
    currentAuth,
    recordAuditEvent,
    recordingStore,
  }: Pick<
    RecordingUploadQueueRouteDependencies,
    "currentAuth" | "recordAuditEvent" | "recordingStore"
  >,
) {
  const recording = await recordingStore.find(recordingId);

  if (!recording || !recordingHasCachedFile(recording)) {
    await recordUploadQueueFailure(c, {
      action: "recordings.upload_queue.enqueue.failed",
      currentAuth,
      reason: recording ? "recording_not_cached" : "recording_not_found",
      recordAuditEvent,
      recordingId,
      targetName: recording?.name,
    });

    return {
      error: recording ? "Recording is not cached" : "Recording not found",
      ok: false as const,
      status: recording ? 409 : 404,
    };
  }

  const policy = await uploadPolicyForQueue(body.uploadPolicyId ?? recording.uploadPolicyId);

  if (!policy.enabled) {
    await recordUploadQueueFailure(c, {
      action: "recordings.upload_queue.enqueue.failed",
      currentAuth,
      reason: "upload_policy_disabled",
      recordAuditEvent,
      recordingId,
      targetName: recording.name,
    });

    return {
      error: "Upload policy is disabled",
      ok: false as const,
      status: 409,
    };
  }

  const item = await enqueueRecordingUpload(recording, {
    ...uploadQueueInputForPolicy(policy, body.reason),
    provider: body.provider ? uploadProviderFromValue(body.provider) : policy.provider,
    target: body.target ?? policy.target,
  });

  await recordAuditEvent(c, {
    action: "recordings.upload_queue.enqueue.succeeded",
    auth: currentAuth(c),
    correlationIds: {
      recordingId: recording.id,
      uploadQueueItemId: item.id,
    },
    details: uploadQueueAuditDetails(item),
    outcome: "succeeded",
    permission: "recording:control",
    target: {
      id: recording.id,
      name: recording.name,
      type: "recording",
    },
  });

  return { item, ok: true as const };
}

async function recordBulkUploadQueueFailure(
  c: Context<AppBindings>,
  reason: string,
  input: Pick<RecordingUploadQueueRouteDependencies, "currentAuth" | "recordAuditEvent"> & {
    details?: Record<string, unknown>;
    outcome?: "denied" | "failed";
  },
) {
  return input.recordAuditEvent(c, {
    action: "recordings.upload_queue.bulk_enqueue.failed",
    auth: input.currentAuth(c),
    details: input.details,
    outcome: input.outcome ?? "failed",
    permission: "recording:control",
    reason,
    target: {
      id: "recording_collection",
      type: "recording_collection",
    },
  });
}

async function recordUploadQueueFailure(
  c: Context<AppBindings>,
  input: Pick<RecordingUploadQueueRouteDependencies, "currentAuth" | "recordAuditEvent"> & {
    action: string;
    itemId?: string;
    outcome?: "denied" | "failed";
    reason: string;
    recordingId?: string;
    targetName?: string;
  },
) {
  return input.recordAuditEvent(c, {
    action: input.action,
    auth: input.currentAuth(c),
    correlationIds: {
      ...(input.itemId ? { uploadQueueItemId: input.itemId } : {}),
      ...(input.recordingId ? { recordingId: input.recordingId } : {}),
    },
    outcome: input.outcome ?? "failed",
    permission: "recording:control",
    reason: input.reason,
    target: {
      id: input.recordingId ?? input.itemId,
      name: input.targetName,
      type: input.recordingId ? "recording" : "upload_queue",
    },
  });
}

function uploadQueueAuditDetails(item: UploadQueueItem) {
  return {
    attemptCount: item.attemptCount,
    maxAttempts: item.maxAttempts,
    nextAttemptAt: item.nextAttemptAt,
    provider: item.provider,
    status: item.status,
    target: item.target,
    uploadPolicyId: item.uploadPolicyId,
  };
}

async function uploadQueueItem(itemId: string) {
  return (await listUploadQueueItems()).find((item) => item.id === itemId);
}

function uploadQueueItemMatches(
  item: UploadQueueItem,
  filters: z.infer<typeof uploadQueueQuerySchema>,
) {
  return (
    (!filters.provider || item.provider === filters.provider) &&
    (!filters.recordingId || item.recordingId === filters.recordingId) &&
    (!filters.status || item.status === filters.status)
  );
}
