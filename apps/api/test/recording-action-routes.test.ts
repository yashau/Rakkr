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
  RecordingProfile,
  RecordingSummary,
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

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-actions-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(routeRoot, "recording-cache");
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(routeRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(routeRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { createRecordingJob, failRecordingJob } = await import("../src/recording-jobs.js");
const { enqueueRecordingUpload } = await import("../src/upload-queue.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording action summary returns ready actions links jobs and upload queue context", async () => {
  const recording = recordingSummary({
    cached: true,
    cachePath: "ad-hoc/rec_action_ready.mp3",
    id: `rec_action_ready_${randomUUID()}`,
    status: "cached",
  });
  const failedJob = await createRecordingJob(recording);
  await failRecordingJob(failedJob.id, "capture_failed");
  const queuedUpload = await enqueueRecordingUpload(recording, {
    policyId: "upload-policy-stub",
    provider: "stub",
    reason: "manual_action_summary",
  });
  const permissionCalls: PermissionCall[] = [];
  const app = recordingActionsApp({
    permissionCalls,
    recordingStore: memoryRecordingStore([recording]),
    user: currentUser([
      "recording:control",
      "recording:delete",
      "recording:download",
      "recording:edit",
      "recording:playback",
      "recording:read",
    ]),
    visibleRecordingIds: [recording.id],
  });

  const response = await app.request(`/api/v1/recordings/${recording.id}/actions`);
  const body = (await response.json()) as RecordingActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.action, "recordings.actions.read");
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(body.data.recording.id, recording.id);
  assert.equal(body.data.jobs.latest?.id, failedJob.id);
  assert.equal(body.data.jobs.retryable?.id, failedJob.id);
  assert.equal(body.data.uploadQueueItems[0]?.id, queuedUpload.id);
  assert.equal(body.data.actions.playback.enabled, true);
  assert.equal(body.data.actions.download.enabled, true);
  assert.equal(body.data.actions.queueUpload.enabled, true);
  assert.equal(body.data.actions.editMetadata.enabled, true);
  assert.equal(body.data.actions.delete.enabled, true);
  assert.equal(body.data.actions.retryJob.enabled, true);
  assert.equal(body.data.actions.retryJob.href, `/api/v1/recording-jobs/${failedJob.id}/retry`);
  assert.equal(body.data.actions.stop.enabled, false);
  assert.equal(body.data.actions.stop.reason, "recording_not_active");
  assert.equal(body.data.links.stream, `/api/v1/recordings/${recording.id}/stream`);
  assert.equal(body.data.links.retryJob, `/api/v1/recording-jobs/${failedJob.id}/retry`);
});

test("recording action summary reports active lifecycle blockers", async () => {
  const recording = recordingSummary({
    cached: false,
    cachePath: undefined,
    id: `rec_action_active_${randomUUID()}`,
    status: "recording",
  });
  const activeJob = await createRecordingJob(recording);
  const app = recordingActionsApp({
    recordingStore: memoryRecordingStore([recording]),
    user: currentUser([
      "recording:control",
      "recording:delete",
      "recording:download",
      "recording:playback",
      "recording:read",
    ]),
    visibleRecordingIds: [recording.id],
  });

  const response = await app.request(`/api/v1/recordings/${recording.id}/actions`);
  const body = (await response.json()) as RecordingActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.jobs.active?.id, activeJob.id);
  assert.equal(body.data.actions.stop.enabled, true);
  assert.equal(body.data.actions.delete.enabled, false);
  assert.equal(body.data.actions.delete.reason, "recording_active");
  assert.equal(body.data.actions.playback.enabled, false);
  assert.equal(body.data.actions.playback.reason, "recording_not_cached");
  assert.equal(body.data.actions.retryJob.enabled, false);
  assert.equal(body.data.actions.retryJob.reason, "active_job_exists");
});

test("recording action summary uses scoped recording context for readiness", async () => {
  const scopedRecording = recordingSummary({
    cachePath: "ad-hoc/rec_action_scoped.mp3",
    cached: true,
    id: `rec_action_scoped_${randomUUID()}`,
    name: "Scoped Recording Action",
    status: "cached",
  });
  const rawStoreRecording = recordingSummary({
    cachePath: undefined,
    cached: false,
    id: scopedRecording.id,
    name: "Raw Store Recording Action",
    status: "completed",
  });
  const app = recordingActionsApp({
    recordingStore: memoryRecordingStore([rawStoreRecording]),
    scopedRecordingSnapshots: [scopedRecording],
    user: currentUser([
      "recording:control",
      "recording:delete",
      "recording:download",
      "recording:edit",
      "recording:playback",
      "recording:read",
    ]),
    visibleRecordingIds: [scopedRecording.id],
  });

  const response = await app.request(`/api/v1/recordings/${scopedRecording.id}/actions`);
  const body = (await response.json()) as RecordingActionsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.recording.name, scopedRecording.name);
  assert.equal(body.data.actions.playback.enabled, true);
  assert.equal(body.data.actions.download.enabled, true);
  assert.equal(body.data.actions.queueUpload.enabled, true);
});

test("recording action summary hides recordings outside scoped visibility", async () => {
  const recording = recordingSummary({ id: `rec_action_hidden_${randomUUID()}` });
  const permissionCalls: PermissionCall[] = [];
  const app = recordingActionsApp({
    permissionCalls,
    recordingStore: memoryRecordingStore([recording]),
    user: currentUser(["recording:read"]),
    visibleRecordingIds: [],
  });

  const response = await app.request(`/api/v1/recordings/${recording.id}/actions`);

  assert.equal(response.status, 404);
  assert.equal(permissionCalls.at(-1)?.action, "recordings.actions.read");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: recording.id,
    type: "recording",
  });
});

interface RecordingActionsResponse {
  data: {
    actions: Record<string, { enabled: boolean; href?: string; reason?: string }>;
    jobs: {
      active?: { id: string };
      latest?: { id: string };
      retryable?: { id: string };
    };
    links: Record<string, string | undefined>;
    recording: RecordingSummary;
    uploadQueueItems: Array<{ id: string }>;
  };
}

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function recordingActionsApp({
  permissionCalls = [],
  recordingStore,
  scopedRecordingSnapshots,
  user,
  visibleRecordingIds,
}: {
  permissionCalls?: PermissionCall[];
  recordingStore: RecordingStore;
  scopedRecordingSnapshots?: RecordingSummary[];
  user: CurrentUser;
  visibleRecordingIds: string[];
}) {
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user }),
    currentUser: () => user,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => [],
    scopedRecordings: async () => {
      const recordings = scopedRecordingSnapshots ?? (await recordingStore.list());

      return recordings.filter((recording) => visibleRecordingIds.includes(recording.id));
    },
    settingsStore: memorySettingsStore([defaultVoiceRecordingProfile]),
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
    const user = input.auth?.user ?? currentUser([]);
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: user.id,
        name: user.name,
        roles: user.roles,
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
    async update() {
      throw new Error("not implemented");
    },
    async updateInterface() {
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
      const index = recordings.findIndex((recording) => recording.id === recordingId);

      return index >= 0 ? recordings.splice(index, 1)[0] : undefined;
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

function memorySettingsStore(profiles: RecordingProfile[]): SettingsStore {
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
      return profiles.find((profile) => profile.id === profileId);
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
      return profiles;
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

function currentUser(permissions: Permission[]): CurrentUser {
  return {
    email: "recording-actions@example.com",
    groups: [],
    id: "user_recording_actions",
    name: "Recording Actions User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recordingSummary(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: true,
    cachePath: "ad-hoc/recording-action.mp3",
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: `rec_action_${randomUUID()}`,
    name: "Recording Action Test",
    nodeId: "node_recording_action",
    recordedAt: "2026-06-21T12:00:00.000Z",
    recordingProfileId: defaultVoiceRecordingProfile.id,
    source: "ad_hoc",
    status: "cached",
    tags: ["voice"],
    ...input,
  };
}
