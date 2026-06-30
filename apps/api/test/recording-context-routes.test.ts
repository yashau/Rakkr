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
  HealthEvent,
  Permission,
  RecordingJob,
  RecordingSummary,
  UploadQueueItem,
} from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-context-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "recording-jobs.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(routeRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createRecordingJob } = await import("../src/recording-jobs.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { enqueueRecordingUpload } = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording context route returns scoped operational detail", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const visible = recording({ id: `rec_context_visible_${randomUUID()}` });
  const hidden = recording({ id: `rec_context_hidden_${randomUUID()}` });
  const recordingStore = memoryRecordingStore([visible, hidden]);
  const healthEventStore = createHealthEventStore("", []);
  const visibleJob = await createRecordingJob(visible);
  const hiddenJob = await createRecordingJob(hidden);
  const visibleUpload = await enqueueRecordingUpload(visible, {
    provider: "stub",
    reason: "context_visible",
  });
  const hiddenUpload = await enqueueRecordingUpload(hidden, {
    provider: "stub",
    reason: "context_hidden",
  });
  const visibleHealth = await healthEventStore.create({
    details: { source: "context_visible" },
    openedAt: new Date("2026-06-20T12:00:00.000Z"),
    recordingId: visible.id,
    severity: "warning",
    type: "low_signal",
  });
  const hiddenHealth = await healthEventStore.create({
    details: { source: "context_hidden" },
    openedAt: new Date("2026-06-20T13:00:00.000Z"),
    recordingId: hidden.id,
    severity: "critical",
    type: "noise_floor",
  });
  const app = recordingApp({
    auditStore,
    healthEventStore,
    permissionCalls,
    recordingStore,
    visibleRecordingIds: [visible.id],
  });

  const visibleResponse = await app.request(`/api/v1/recordings/${visible.id}/context`);
  const hiddenResponse = await app.request(`/api/v1/recordings/${hidden.id}/context`);
  const missingResponse = await app.request("/api/v1/recordings/rec_missing_context/context");
  const body = (await visibleResponse.json()) as { data: RecordingContext };
  const [successEvent] = await auditStore.list({ action: "recordings.context.read.succeeded" });
  const failedEvents = await auditStore.list({ action: "recordings.context.read.failed" });

  assert.equal(visibleResponse.status, 200);
  assert.equal(body.data.recording.id, visible.id);
  assert.deepEqual(
    body.data.jobs.map((job) => job.id),
    [visibleJob.id],
  );
  assert.deepEqual(
    body.data.healthEvents.map((event) => event.id),
    [visibleHealth.id],
  );
  assert.deepEqual(
    body.data.uploadQueueItems.map((item) => item.id),
    [visibleUpload.id],
  );
  assert.equal(
    body.data.jobs.some((job) => job.id === hiddenJob.id),
    false,
  );
  assert.equal(
    body.data.healthEvents.some((event) => event.id === hiddenHealth.id),
    false,
  );
  assert.equal(
    body.data.uploadQueueItems.some((item) => item.id === hiddenUpload.id),
    false,
  );
  assert.equal(hiddenResponse.status, 404);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(permissionCalls.at(-3), {
    action: "recordings.context.read",
    permission: "recording:read",
    target: { id: visible.id, type: "recording" },
  });
  assert.deepEqual(permissionCalls.at(-2), {
    action: "recordings.context.read",
    permission: "recording:read",
    target: { id: hidden.id, type: "recording" },
  });
  assert.deepEqual(permissionCalls.at(-1), {
    action: "recordings.context.read",
    permission: "recording:read",
    target: { id: "rec_missing_context", type: "recording" },
  });
  assert.equal(successEvent?.target.id, visible.id);
  assert.equal(successEvent?.details.jobCount, 1);
  assert.equal(successEvent?.details.healthEventCount, 1);
  assert.equal(successEvent?.details.uploadQueueItemCount, 1);
  assert.deepEqual(failedEvents.map((event) => [event.target.id, event.reason]).sort(), [
    [hidden.id, "recording_not_found"],
    ["rec_missing_context", "recording_not_found"],
  ]);
});

interface RecordingContext {
  healthEvents: HealthEvent[];
  jobs: RecordingJob[];
  recording: RecordingSummary;
  uploadQueueItems: UploadQueueItem[];
}

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function recordingApp({
  auditStore,
  healthEventStore,
  permissionCalls,
  recordingStore,
  visibleRecordingIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  healthEventStore: ReturnType<typeof createHealthEventStore>;
  permissionCalls: PermissionCall[];
  recordingStore: RecordingStore;
  visibleRecordingIds?: string[];
}) {
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: user() }),
    currentUser: () => user(),
    healthEventStore,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => [],
    scopedRecordings: async () => {
      const recordings = await recordingStore.list();

      return visibleRecordingIds
        ? recordings.filter((candidate) => visibleRecordingIds.includes(candidate.id))
        : recordings;
    },
    settingsStore: memorySettingsStore(),
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    calls.push({
      action,
      permission,
      target: target ? await target(c) : undefined,
    });
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: "user_recording_context",
        name: "Recording Context User",
        roles: ["operator"],
        type: "user",
      },
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

function memoryNodeStore(): NodeStore {
  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find() {
      return undefined;
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return [];
    },
    async rotateCredential() {
      throw new Error("not implemented");
    },
    async updateInterface() {
      throw new Error("not implemented");
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
  };
}

function memorySettingsStore(): SettingsStore {
  return {
    async assignChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async createChannelMapTemplate() {
      throw new Error("not implemented");
    },
    async findChannelMapTemplate() {
      return undefined;
    },
    async findRecordingProfile(profileId) {
      return profileId === defaultVoiceRecordingProfile.id
        ? defaultVoiceRecordingProfile
        : undefined;
    },
    async findWatchdogPolicy() {
      return undefined;
    },
    async listChannelMapAssignments() {
      return [];
    },
    async listChannelMapTemplates() {
      return [];
    },
    async listRecordingProfiles() {
      return [defaultVoiceRecordingProfile];
    },
    async listWatchdogPolicies() {
      return [];
    },
    async rollbackChannelMapAssignment() {
      return undefined;
    },
    async updateChannelMapTemplate() {
      return undefined;
    },
    async updateRecordingProfile() {
      return undefined;
    },
    async updateWatchdogPolicy() {
      return undefined;
    },
  };
}

function user(): CurrentUser {
  return {
    email: "recording-context@example.com",
    groups: [],
    id: "user_recording_context",
    name: "Recording Context User",
    permissions: ["recording:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recording(input: Partial<RecordingSummary>): RecordingSummary {
  return {
    cached: true,
    cachePath: `${input.id ?? "rec_context"}.mp3`,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: `rec_${randomUUID()}`,
    name: "Recording",
    nodeId: "node_context",
    recordedAt: "2026-06-20T12:00:00.000Z",
    recordingProfileId: defaultVoiceRecordingProfile.id,
    source: "ad_hoc",
    status: "cached",
    tags: ["voice"],
    uploadPolicyIds: ["upload-policy-stub"],
    ...input,
  };
}
