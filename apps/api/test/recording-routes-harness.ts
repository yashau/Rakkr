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
  RecordingProfile,
  RecordingSummary,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

export const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(routeRoot, "recording-cache");
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(routeRoot, "upload-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

export { createAuditStore };

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

export interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

export function recordingApp({
  auditStore,
  nodes,
  permissionCalls,
  profiles,
  recordingStore,
  visibleRecordingIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
  profiles: RecordingProfile[];
  recordingStore: RecordingStore;
  visibleRecordingIds?: string[];
}) {
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore: memoryNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: () => memoryNodeStore(nodes).list(),
    scopedRecordings: async () => {
      const recordings = await recordingStore.list();

      return visibleRecordingIds
        ? recordings.filter((recording) => visibleRecordingIds.includes(recording.id))
        : recordings;
    },
    settingsStore: memorySettingsStore(profiles),
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => {
    return async (c, next) => {
      calls.push({
        action,
        permission,
        target: target ? await target(c) : undefined,
      });
      await next();
    };
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_recording_route",
        name: "Recording Route User",
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

function memoryNodeStore(nodes: RecorderNode[]): NodeStore {
  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((node) => node.id === nodeId);
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return nodes;
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

export function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((recording) => recording.id === recordingId);

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
    async transition(recording, allowedFrom) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);
      const current = recordings[index];

      if (!current || !allowedFrom.includes(current.status)) {
        return undefined;
      }

      recordings[index] = recording;

      return recording;
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

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "recording-route@example.com",
    groups: [],
    id: "user_recording_route",
    name: "Recording Route User",
    permissions: ["recording:create"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

export function recorderNode(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Room Alpha Recorder",
    hostname: "room-alpha-recorder",
    id: "node_room_alpha",
    interfaces: [
      {
        alias: "USB Interface",
        backend: "alsa",
        channelCount: 2,
        channels: [
          { alias: "Lectern", index: 1 },
          { alias: "Table", index: 2 },
        ],
        id: "iface_usb_1",
        sampleRates: [48_000],
        systemName: "hw:1,0",
        systemRef: "usb-1-1",
      },
    ],
    ipAddresses: ["10.1.2.3"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Room Alpha",
      site: "Main Site",
    },
    status: "online",
    tags: ["voice"],
  };
}

export function recording(input: Partial<RecordingSummary>): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: `rec_${randomUUID()}`,
    name: "Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: ["voice"],
    ...input,
  };
}
