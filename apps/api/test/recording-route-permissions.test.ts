import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingSummary,
} from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-permissions-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  routeRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  routeRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(routeRoot, "recording-cache");
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "recording-jobs.json");
process.env.RAKKR_RECORDING_STORE_PATH = path.join(routeRoot, "recordings.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(routeRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(routeRoot, "upload-queue.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(routeRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createNodeStore } = await import("../src/node-store.js");
const { createRecordingStore } = await import("../src/recording-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording routes deny users without required permissions", async () => {
  const auditStore = createAuditStore("");
  const deniedUser = user([]);
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: deniedUser }),
    currentUser: () => deniedUser,
    nodeStore: createNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: createRecordingStore([recording()]),
    requirePermission: denyMissingPermission(auditStore, deniedUser),
    scopedRecordings: async () => [recording()],
    settingsStore: createSettingsStore([defaultVoiceRecordingProfile]),
  });

  const responses = await Promise.all([
    app.request("/api/v1/recordings"),
    app.request("/api/v1/recordings/export"),
    app.request("/api/v1/recordings/facets"),
    app.request("/api/v1/recording-jobs"),
    app.request("/api/v1/upload-queue"),
    app.request(`/api/v1/recordings/${recording().id}/playback`, { method: "POST" }),
    app.request(`/api/v1/recordings/${recording().id}/download`, { method: "POST" }),
    app.request(`/api/v1/recordings/${recording().id}/stream`),
    app.request(`/api/v1/recordings/${recording().id}/file`),
    requestJson(app, "/api/v1/recordings/bulk-metadata", "PATCH", {
      addTags: ["review"],
      recordingIds: [recording().id],
    }),
    requestJson(app, "/api/v1/recordings/bulk-delete", "POST", {
      recordingIds: [recording().id],
    }),
    requestJson(app, `/api/v1/recordings/${recording().id}/metadata`, "PATCH", {
      name: "Blocked Rename",
    }),
    app.request(`/api/v1/recordings/${recording().id}`, { method: "DELETE" }),
    requestJson(app, "/api/v1/recordings", "POST", { nodeId: node().id }),
    app.request(`/api/v1/recordings/${recording().id}/stop`, { method: "POST" }),
    requestJson(app, `/api/v1/recordings/${recording().id}/upload-queue`, "POST", {
      reason: "manual",
    }),
    requestJson(app, "/api/v1/recordings/bulk-upload-queue", "POST", {
      recordingIds: [recording().id],
    }),
    app.request("/api/v1/upload-queue/upload_missing/retry", { method: "POST" }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    Array.from({ length: responses.length }, () => 403),
  );
  assert.deepEqual(
    Object.fromEntries(deniedEvents.map((event) => [event.action, event.permission]).sort()),
    {
      "recording_jobs.read": "recording:read",
      "recordings.bulk_delete": "recording:delete",
      "recordings.delete": "recording:delete",
      "recordings.download.file": "recording:download",
      "recordings.download.prepare": "recording:download",
      "recordings.export": "recording:read",
      "recordings.facets.read": "recording:read",
      "recordings.metadata.bulk_update": "recording:edit",
      "recordings.metadata.update": "recording:edit",
      "recordings.playback.start": "recording:playback",
      "recordings.playback.stream": "recording:playback",
      "recordings.read": "recording:read",
      "recordings.start": "recording:create",
      "recordings.stop": "recording:control",
      "recordings.upload_queue.bulk_enqueue": "recording:control",
      "recordings.upload_queue.enqueue": "recording:control",
      "recordings.upload_queue.read": "recording:read",
      "recordings.upload_queue.retry": "recording:control",
    },
  );
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.actor.id === deniedUser.id));
});

function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
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

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "recording-denied@example.com",
    groups: [],
    id: "user_recording_denied_test",
    name: "Recording Denied Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Recording Permission Node",
    hostname: "recording-permission-node",
    id: "node_recording_permission_test",
    interfaces: [],
    ipAddresses: ["10.0.0.70"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Council Room",
      site: "Main Site",
    },
    status: "online",
    tags: ["voice"],
  };
}

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: true,
    cachePath: "ad-hoc/rec_recording_permission_test.mp3",
    durationSeconds: 120,
    folder: "Ad Hoc/2026/06",
    healthStatus: "healthy",
    id: "rec_recording_permission_test",
    name: "Recording Permission Test",
    nodeId: node().id,
    recordedAt: "2026-06-18T12:00:00.000Z",
    recordingProfileId: defaultVoiceRecordingProfile.id,
    source: "ad_hoc",
    status: "cached",
    tags: ["voice"],
    ...input,
  };
}
