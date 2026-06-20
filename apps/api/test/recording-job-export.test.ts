import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingJob,
  RecordingProfile,
  RecordingSummary,
} from "@rakkr/shared";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-job-export-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(routeRoot, "retention-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { filterRecordingJobsForExport, recordingJobsCsv } =
  await import("../src/recording-job-export.js");
const { createRecordingJob, failRecordingJob } = await import("../src/recording-jobs.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording job export helpers filter and render csv", () => {
  const visibleJob = job({
    command: { ...job().command, captureDevice: "hw:EXPORT,0" },
    id: "job_export_visible",
    status: "queued",
  });
  const hiddenByStatus = job({
    command: { ...job().command, captureDevice: "hw:EXPORT,1" },
    id: "job_export_failed",
    status: "failed",
  });
  const hiddenBySearch = job({
    command: { ...job().command, captureDevice: "hw:OTHER,0" },
    id: "job_other",
    status: "queued",
  });

  const filtered = filterRecordingJobsForExport([visibleJob, hiddenByStatus, hiddenBySearch], {
    search: "export",
    status: "queued",
  });
  const csv = recordingJobsCsv(filtered);

  assert.deepEqual(
    filtered.map((recordingJob) => recordingJob.id),
    ["job_export_visible"],
  );
  assert.match(csv, /^id,recordingId,nodeId,status,claimedBy/m);
  assert.match(csv, /job_export_visible,rec_1,node_1,queued/);
  assert.match(csv, /hw:EXPORT/);
  assert.doesNotMatch(csv, /job_export_failed/);
  assert.doesNotMatch(csv, /job_other/);
});

test("recording job export route is RBAC-gated and audited", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore: memoryRecordingStore([]),
  });

  const response = await app.request("/api/v1/recording-jobs/export?status=queued&search=room");
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "recording_jobs.export.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.export");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "recording_job_collection",
    type: "recording_collection",
  });
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="rakkr-recording-jobs-/,
  );
  assert.match(csv, /^id,recordingId,nodeId,status,claimedBy/m);
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.details.exportedCount, 0);
  assert.deepEqual(event?.details.filters, {
    search: "room",
    status: "queued",
  });
});

test("recording job retry route is RBAC-gated audited and resets recording state", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recording = recordingSummary({
    cachePath: path.join(routeRoot, "stale.wav"),
    cached: true,
    checksum: "stale-checksum",
    durationSeconds: 12,
    healthStatus: "critical",
    id: `rec_retry_${randomUUID()}`,
    status: "failed",
  });
  const recordingStore = memoryRecordingStore([recording]);
  const sourceJob = await createRecordingJob(recording, {
    captureDevice: "hw:Retry,0",
  });

  await failRecordingJob(sourceJob.id, "capture_failed");

  const app = recordingApp({
    auditStore,
    permissionCalls,
    recordingStore,
  });
  const response = await app.request(`/api/v1/recording-jobs/${sourceJob.id}/retry`, {
    method: "POST",
  });
  const body = (await response.json()) as { data: RecordingJob };
  const updatedRecording = await recordingStore.find(recording.id);
  const [event] = await auditStore.list({ action: "recording_jobs.retry.succeeded" });

  assert.equal(response.status, 201);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:control");
  assert.equal(permissionCalls.at(-1)?.action, "recording_jobs.retry");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: recording.id,
    type: "recording",
  });
  assert.notEqual(body.data.id, sourceJob.id);
  assert.equal(body.data.status, "queued");
  assert.equal(body.data.recordingId, recording.id);
  assert.equal(body.data.command.captureDevice, "hw:Retry,0");
  assert.equal(updatedRecording?.status, "recording");
  assert.equal(updatedRecording?.cached, false);
  assert.equal(updatedRecording?.cachePath, undefined);
  assert.equal(updatedRecording?.checksum, undefined);
  assert.equal(updatedRecording?.durationSeconds, 0);
  assert.equal(updatedRecording?.healthStatus, "unknown");
  assert.equal(event?.permission, "recording:control");
  assert.equal(event?.target.id, recording.id);
  assert.equal(event?.before?.jobId, sourceJob.id);
  assert.equal(event?.after?.jobId, body.data.id);
  assert.equal(event?.correlationIds?.sourceJobId, sourceJob.id);
  assert.equal(event?.correlationIds?.retryJobId, body.data.id);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function recordingApp({
  auditStore,
  permissionCalls,
  recordingStore,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  permissionCalls: PermissionCall[];
  recordingStore: RecordingStore;
}) {
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: user() }),
    currentUser: () => user(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedRecordings: async () => recordingStore.list(),
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
        id: "user_recording_job_export",
        name: "Recording Job Export User",
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
  const node: RecorderNode = {
    agentVersion: "0.1.0",
    alias: "Room Recorder",
    hostname: "room-recorder",
    id: "node_1",
    interfaces: [],
    ipAddresses: ["10.1.2.3"],
    lastSeenAt: "2026-06-20T12:00:00.000Z",
    location: { room: "Room", site: "Main" },
    status: "online",
    tags: [],
  };

  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodeId === node.id ? node : undefined;
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return [node];
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
    async delete() {
      return undefined;
    },
    async find(recordingId) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      recordings.unshift(recording);
    },
  };
}

function memorySettingsStore(): SettingsStore {
  return {
    async findRecordingProfile(profileId) {
      return profileId === defaultVoiceRecordingProfile.id
        ? defaultVoiceRecordingProfile
        : undefined;
    },
    async listChannelMapAssignments() {
      return [];
    },
    async listRecordingProfiles(): Promise<RecordingProfile[]> {
      return [defaultVoiceRecordingProfile];
    },
  } as SettingsStore;
}

function user(): CurrentUser {
  return {
    email: "recording-job-export@example.com",
    groups: [],
    id: "user_recording_job_export",
    name: "Recording Job Export User",
    permissions: ["recording:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function job(input: Partial<RecordingJob> = {}): RecordingJob {
  return {
    command: {
      captureChannels: 2,
      captureDevice: "hw:0,0",
      captureFormat: "S16_LE",
      captureSampleRate: 48000,
      durationSeconds: 3600,
      outputCodec: "wav",
      outputFileName: "recording.wav",
      type: "alsa_capture",
    },
    createdAt: "2026-06-20T12:00:00.000Z",
    id: "job_1",
    nodeId: "node_1",
    recordingId: "rec_1",
    status: "queued",
    ...input,
  };
}

function recordingSummary(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "tests",
    healthStatus: "unknown",
    id: "rec_1",
    name: "Retry Recording",
    nodeId: "node_1",
    recordedAt: "2026-06-20T12:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: ["voice"],
    ...input,
  };
}
