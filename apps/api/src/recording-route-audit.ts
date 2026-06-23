import type { Context } from "hono";
import type { Permission, RecordingSummary } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent } from "./http-types.js";

interface RecordingRouteAuditDependencies {
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
}

export function createRecordingRouteAudit({
  currentAuth,
  recordAuditEvent,
}: RecordingRouteAuditDependencies) {
  return {
    async collectionSucceeded(
      c: Context<AppBindings>,
      input: { action: string; details?: Record<string, unknown> },
    ) {
      await recordAuditEvent(c, {
        action: input.action,
        auth: currentAuth(c),
        details: input.details,
        outcome: "succeeded",
        permission: "recording:read",
        target: {
          id: "recording_collection",
          type: "recording_collection",
        },
      });
    },

    async fileFailure(
      c: Context<AppBindings>,
      input: {
        action: string;
        permission: Permission;
        reason: string;
        recordingId: string;
        targetName?: string;
      },
    ) {
      await recordAuditEvent(c, {
        action: input.action,
        auth: currentAuth(c),
        outcome: "failed",
        permission: input.permission,
        reason: input.reason,
        target: {
          id: input.recordingId,
          name: input.targetName,
          type: "recording",
        },
      });
    },

    async readFailure(
      c: Context<AppBindings>,
      input: {
        action: string;
        details?: Record<string, unknown>;
        reason: string;
        recordingId?: string;
      },
    ) {
      await recordAuditEvent(c, {
        action: input.action,
        auth: currentAuth(c),
        details: input.details,
        outcome: "failed",
        permission: "recording:read",
        reason: input.reason,
        target: input.recordingId
          ? {
              id: input.recordingId,
              type: "recording",
            }
          : {
              id: "recording_collection",
              type: "recording_collection",
            },
      });
    },

    async recordingSucceeded(
      c: Context<AppBindings>,
      input: {
        action: string;
        correlationIds?: Record<string, string>;
        details?: Record<string, unknown>;
        recording: RecordingSummary;
      },
    ) {
      await recordAuditEvent(c, {
        action: input.action,
        auth: currentAuth(c),
        correlationIds: input.correlationIds,
        details: input.details,
        outcome: "succeeded",
        permission: "recording:read",
        target: {
          id: input.recording.id,
          name: input.recording.name,
          type: "recording",
        },
      });
    },
  };
}
