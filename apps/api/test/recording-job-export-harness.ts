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
  MeterFrame,
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
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

export { memoryRecordingStore } from "./recording-store-mock.js";

export const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-job-export-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(routeRoot, "retention-policies.json");

export const { createAuditStore } = await import("../src/audit-store.js");
export const { registerAgentRoutes } = await import("../src/agent-routes.js");
export const { createHealthEventStore } = await import("../src/health-store.js");
export const { filterRecordingJobsForExport, recordingJobsCsv } =
  await import("../src/recording-job-export.js");
export const { createRecordingJob, failRecordingJob } = await import("../src/recording-jobs.js");
export const { registerRecordingRoutes } = await import("../src/recording-routes.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

export interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

export interface RecordingJobActionsResponse {
  data: {
    actions: Record<
      string,
      { enabled: boolean; href?: string; payload?: Record<string, unknown>; reason?: string }
    >;
    job: RecordingJob;
    recording?: RecordingSummary;
    retryConflict?: RecordingJob;
  };
}

export function recordingApp({
  auditStore,
  permissionCalls,
  permissions,
  recordingStore,
  scopedRecordingSnapshots,
  visibleRecordingIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  permissionCalls: PermissionCall[];
  permissions?: Permission[];
  recordingStore: RecordingStore;
  scopedRecordingSnapshots?: RecordingSummary[];
  visibleRecordingIds?: string[];
}) {
  const app = new Hono<AppBindings>();
  const currentUser = user(permissions);

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => [],
    scopedRecordings: async () => {
      const recordings = scopedRecordingSnapshots ?? (await recordingStore.list());

      return visibleRecordingIds
        ? recordings.filter((recording) => visibleRecordingIds.includes(recording.id))
        : recordings;
    },
    settingsStore: memorySettingsStore(),
  });

  return app;
}

export function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    calls.push({
      action,
      permission,
      target: target ? await target(c) : undefined,
    });
    await next();
  };
}

export function recordAuditEvent(
  auditStore: ReturnType<typeof createAuditStore>,
): RecordAuditEvent {
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

export function memoryNodeStore(): NodeStore {
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

export function memoryMeterFrameStore(): MeterFrameStore {
  return {
    async history(): Promise<MeterFrame[]> {
      return [];
    },
    async latest() {
      return undefined;
    },
    async save(frame) {
      return {
        frame,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

export function memorySettingsStore(): SettingsStore {
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

export function user(permissions: Permission[] = ["recording:read"]): CurrentUser {
  return {
    email: "recording-job-export@example.com",
    groups: [],
    id: "user_recording_job_export",
    name: "Recording Job Export User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

export function job(input: Partial<RecordingJob> = {}): RecordingJob {
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

export function recordingSummary(input: Partial<RecordingSummary> = {}): RecordingSummary {
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
