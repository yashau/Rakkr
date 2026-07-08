import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuditEvent, CurrentUser, RecordingSummary } from "@rakkr/shared";
import type { RecordAuditEvent, RequirePermission } from "../src/http-types.js";

export { memoryRecordingStore } from "./recording-store-mock.js";

export const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-runner-"));
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(runnerRoot, "destinations.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(runnerRoot, "policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(runnerRoot, "queue.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(runnerRoot, "cache");
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(runnerRoot, "chunks.json");

export const { createAuditStore } = await import("../src/audit-store.js");
export const { createHealthEventStore } = await import("../src/health-store.js");
export const { createUploadPolicy } = await import("../src/upload-policies.js");
export const { createUploadDestinationStore } = await import("../src/upload-destinations.js");
export const { registerUploadRunnerRoutes } = await import("../src/upload-runner-routes.js");
export const { createUploadRunner } = await import("../src/upload-runner.js");
export const { enqueueRecordingUpload, listUploadQueueItems } =
  await import("../src/upload-queue.js");
export const { upsertRecordingChunk } = await import("../src/recording-chunks.js");

test.after(async () => {
  await rm(runnerRoot, { force: true, recursive: true });
});

export const allow: RequirePermission = () => async (_c, next) => {
  await next();
};

export function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: viewer() },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: ["viewer"],
      },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

export function recordAuditEvent(
  auditStore: ReturnType<typeof createAuditStore>,
): RecordAuditEvent {
  return async (_c, input) => {
    const actor = input.actor ?? {
      id: input.auth?.user?.id ?? "anonymous",
      name: input.auth?.user?.name ?? "Anonymous",
      roles: input.auth?.user?.roles ?? [],
      type: "user" as const,
    };
    const event: AuditEvent = {
      action: input.action,
      actor,
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

export function user(): CurrentUser {
  return {
    email: "upload-runner@example.com",
    groups: [],
    id: "user_upload_runner_test",
    name: "Upload Runner Test",
    permissions: ["recording:control", "recording:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["admin"],
  };
}

export function viewer(permissions: CurrentUser["permissions"] = []): CurrentUser {
  return {
    email: "upload-runner-viewer@example.com",
    groups: [],
    id: "user_upload_runner_viewer_test",
    name: "Upload Runner Viewer Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

export function recording(id = "rec_upload_runner_test", contents?: string): RecordingSummary {
  return {
    cachePath: `scheduled/${id}.mp3`,
    cached: true,
    checksum: contents ? sha256Prefixed(contents) : `sha256:${id}`,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "healthy",
    id,
    name: "Council Meeting",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: ["council"],
  };
}

export async function cacheRecording(id: string, contents: string) {
  const cachePath = path.join(runnerRoot, "cache", "scheduled", `${id}.mp3`);

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents);

  return cachePath;
}

export function sha256Prefixed(contents: string) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

export function throwingSmbClient() {
  return {
    async close() {},
    async connect() {
      throw new Error("smb_connect_failed");
    },
    async mkdir() {},
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
  };
}

export function fakeSmbClient() {
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];

  return {
    client: {
      async close() {},
      async connect() {},
      async mkdir(targetPath: string) {
        dirs.push(targetPath);
      },
      async readFile(targetPath: string) {
        const data = files.get(targetPath);

        if (!data) {
          const error = new Error("ENOENT") as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        }

        return data;
      },
      async writeFile(targetPath: string, data: Buffer | string) {
        files.set(targetPath, Buffer.from(data));
      },
    },
    dirs,
    files,
  };
}
