import type { Context, Hono } from "hono";
import type { UploadQueueRunSummary, UploadRunnerStatus } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { UploadRunner } from "./upload-runner.js";

interface UploadRunnerRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  uploadRunner: UploadRunner;
}

export function registerUploadRunnerRoutes({
  app,
  currentAuth,
  recordAuditEvent,
  requirePermission,
  uploadRunner,
}: UploadRunnerRouteDependencies) {
  app.get(
    "/api/v1/upload-runner",
    requirePermission("recording:read", "recordings.upload_runner.read", () => ({
      type: "upload_runner",
    })),
    (c) => c.json({ data: uploadRunner.status() }),
  );

  app.post(
    "/api/v1/upload-runner/run",
    requirePermission("recording:control", "recordings.upload_runner.run", () => ({
      type: "upload_runner",
    })),
    async (c) => {
      const before = uploadRunner.status();

      try {
        const summary = await uploadRunner.runOnce();
        const after = uploadRunner.status();

        await recordAuditEvent(c, {
          action: "recordings.upload_runner.run.succeeded",
          after: statusSnapshot(after),
          auth: currentAuth(c),
          before: statusSnapshot(before),
          details: summaryDetails(summary),
          outcome: summaryOutcome(summary),
          permission: "recording:control",
          target: { type: "upload_runner" },
        });

        return c.json({ data: after, summary });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "upload_runner_run_failed";

        await recordAuditEvent(c, {
          action: "recordings.upload_runner.run.failed",
          auth: currentAuth(c),
          before: statusSnapshot(before),
          outcome: "failed",
          permission: "recording:control",
          reason,
          target: { type: "upload_runner" },
        });

        return c.json({ error: "Upload runner failed", reason }, 500);
      }
    },
  );
}

function statusSnapshot(status: UploadRunnerStatus) {
  return {
    batchSize: status.batchSize,
    intervalSeconds: status.intervalSeconds,
    lastRunAt: status.lastRunAt,
    running: status.running,
    started: status.started,
  };
}

function summaryDetails(summary: UploadQueueRunSummary) {
  return {
    attempted: summary.attempted,
    deferred: summary.deferred,
    failed: summary.failed,
    succeeded: summary.succeeded,
  };
}

function summaryOutcome(summary: UploadQueueRunSummary) {
  return summary.failed > 0 || summary.deferred > 0 ? "partial" : "succeeded";
}
