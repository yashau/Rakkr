import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import {
  defaultKeepControllerCacheRetentionPolicy,
  defaultStubUploadPolicy,
  defaultVoiceRecordingProfile,
} from "@rakkr/shared";
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

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-start-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { claimRecordingJob, createRecordingJob } = await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("ad hoc recording start uses requested capture backend and interface", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const permissionCalls: PermissionCall[] = [];
  const profile = flacProfile();
  const node = recorderNode();
  const app = recordingApp({
    auditStore,
    nodes: [node],
    permissionCalls,
    profiles: [profile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureBackend: "jack",
      captureInterfaceId: "iface_jack_manual",
      folder: "Ad Hoc/Manual",
      name: "Manual Capture",
      nodeId: node.id,
      recordingProfileId: profile.id,
      tags: ["voice", "Voice", "council"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as {
    data: RecordingSummary;
    job: { command: Record<string, unknown>; nodeId: string };
  };
  const [event] = await auditStore.list({ action: "recordings.start.succeeded" });
  const [stored] = await recordingStore.list();

  assert.equal(response.status, 202);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "recordings.start",
    permission: "recording:create",
    target: { id: node.id, type: "node" },
  });
  assert.equal(body.data.id, stored?.id);
  assert.equal(body.data.folder, "Ad Hoc/Manual");
  assert.equal(body.data.name, "Manual Capture");
  assert.deepEqual(body.data.tags, ["voice", "council"]);
  assert.equal(body.job.nodeId, node.id);
  assert.equal(body.job.command.captureBackend, "jack");
  assert.equal(body.job.command.captureDevice, "jack:manual");
  assert.equal(body.job.command.captureInterfaceId, "iface_jack_manual");
  assert.equal(body.job.command.outputCodec, "flac");
  assert.equal(body.job.command.outputFileName, `${body.data.id}.flac`);
  assert.equal(event?.details.captureBackend, "jack");
  assert.equal(event?.details.captureInterfaceId, "iface_jack_manual");
  assert.equal(event?.details.profileId, profile.id);
  assert.equal(event?.target.id, body.data.id);
});

test("ad hoc recording start rejects interfaces outside the requested node", async () => {
  const auditStore = createAuditStore("");
  const node = recorderNode();
  const app = recordingApp({
    auditStore,
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore(),
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureInterfaceId: "iface_elsewhere",
      nodeId: node.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recordings.start.failed" });

  assert.equal(response.status, 409);
  assert.equal(event?.reason, "recording_interface_not_found");
  assert.equal(event?.target.id, node.id);
});

test("ad hoc recording start prefers stable ALSA system refs", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const node = recorderNode({
    id: `node_stable_alsa_${randomUUID()}`,
    interfaces: [
      {
        alias: "X32 USB",
        backend: "alsa",
        channelCount: 32,
        channels: [{ alias: "Input 1", index: 1 }],
        id: "iface_x32_usb",
        sampleRates: [48_000],
        systemName: "X-USB USB Audio",
        systemRef: "hw:CARD=XUSB,DEV=0",
      },
    ],
  });
  const app = recordingApp({
    auditStore,
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureInterfaceId: "iface_x32_usb",
      nodeId: node.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { job: { command: Record<string, unknown> } };

  assert.equal(response.status, 202);
  assert.equal(body.job.command.captureBackend, "alsa");
  assert.equal(body.job.command.captureDevice, "hw:CARD=XUSB,DEV=0");
});

test("ad hoc recording start normalizes prefixed ALSA system refs", async () => {
  const recordingStore = memoryRecordingStore();
  const node = recorderNode({
    id: `node_prefixed_alsa_${randomUUID()}`,
    interfaces: [
      {
        alias: "X32 USB",
        backend: "alsa",
        channelCount: 32,
        channels: [{ alias: "Input 1", index: 1 }],
        id: "iface_x32_prefixed_usb",
        sampleRates: [48_000],
        systemName: "X-USB USB Audio",
        systemRef: "alsa:hw:CARD=XUSB,DEV=0",
      },
    ],
  });
  const app = recordingApp({
    auditStore: createAuditStore(""),
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      captureInterfaceId: "iface_x32_prefixed_usb",
      nodeId: node.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { job: { command: Record<string, unknown> } };

  assert.equal(response.status, 202);
  assert.equal(body.job.command.captureDevice, "hw:CARD=XUSB,DEV=0");
});

test("ad hoc recording start rejects active jobs on the requested node", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const node = recorderNode({ id: `node_active_start_${randomUUID()}` });
  const activeRecording = recordingSummary({
    id: `rec_active_start_${randomUUID()}`,
    nodeId: node.id,
  });
  const activeJob = await createRecordingJob(activeRecording);
  await claimRecordingJob(activeJob.id, node.id);
  const app = recordingApp({
    auditStore,
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({ nodeId: node.id }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { reason: string };
  const [event] = await auditStore.list({ action: "recordings.start.failed" });
  const recordings = await recordingStore.list();

  assert.equal(response.status, 409);
  assert.equal(body.reason, "active_recording_job_exists");
  assert.equal(event?.reason, "active_recording_job_exists");
  assert.equal(event?.target.type, "recording_job");
  assert.equal(recordings.length, 0);
});

test("ad hoc recording start only operates on scoped visible nodes", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const visible = recorderNode({ id: "node_start_visible" });
  const hidden = recorderNode({ id: "node_start_hidden" });
  const app = recordingApp({
    auditStore,
    nodes: [visible, hidden],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
    scopedNodeIds: [visible.id],
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({ nodeId: hidden.id }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recordings.start.failed" });
  const recordings = await recordingStore.list();

  assert.equal(response.status, 404);
  assert.equal(event?.reason, "node_not_found");
  assert.equal(event?.target.id, hidden.id);
  assert.equal(event?.target.type, "node");
  assert.equal(recordings.length, 0);
});

test("ad hoc recording start rejects recording profiles outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const hiddenProfile = flacProfile({ id: "profile_hidden_start" });
  const node = recorderNode();
  const app = recordingApp({
    auditStore,
    hasResourceScope: async (_user, target) => target.id !== hiddenProfile.id,
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile, hiddenProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      nodeId: node.id,
      recordingProfileId: hiddenProfile.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recordings.start.failed" });
  const recordings = await recordingStore.list();

  assert.equal(response.status, 403);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "missing_resource_scope");
  assert.equal(event?.target.id, hiddenProfile.id);
  assert.equal(event?.target.type, "recording_profile");
  assert.equal(recordings.length, 0);
});

test("ad hoc recording start rejects upload policies outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const node = recorderNode();
  const app = recordingApp({
    auditStore,
    hasResourceScope: async (_user, target) => target.id !== defaultStubUploadPolicy.id,
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      nodeId: node.id,
      uploadPolicyId: defaultStubUploadPolicy.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recordings.start.failed" });
  const recordings = await recordingStore.list();

  assert.equal(response.status, 403);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "missing_resource_scope");
  assert.equal(event?.target.id, defaultStubUploadPolicy.id);
  assert.equal(event?.target.type, "upload_policy");
  assert.equal(recordings.length, 0);
});

test("ad hoc recording start rejects retention policies outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const node = recorderNode();
  const app = recordingApp({
    auditStore,
    hasResourceScope: async (_user, target) =>
      target.id !== defaultKeepControllerCacheRetentionPolicy.id,
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      nodeId: node.id,
      retentionPolicyId: defaultKeepControllerCacheRetentionPolicy.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recordings.start.failed" });
  const recordings = await recordingStore.list();

  assert.equal(response.status, 403);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "missing_resource_scope");
  assert.equal(event?.target.id, defaultKeepControllerCacheRetentionPolicy.id);
  assert.equal(event?.target.type, "retention_policy");
  assert.equal(recordings.length, 0);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function recordingApp({
  auditStore,
  hasResourceScope,
  nodes,
  permissionCalls,
  profiles,
  recordingStore,
  scopedNodeIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  hasResourceScope?: (user: CurrentUser, target: AuditTarget) => Promise<boolean>;
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
  profiles: RecordingProfile[];
  recordingStore: RecordingStore;
  scopedNodeIds?: string[];
}) {
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    hasResourceScope,
    nodeStore: memoryNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () =>
      nodes.filter(
        (candidate) => scopedNodeIds === undefined || scopedNodeIds.includes(candidate.id),
      ),
    scopedRecordings: async () => recordingStore.list(),
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
      actor: {
        id: "user_recording_start_route",
        name: "Recording Start Route User",
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
    async update() {
      throw new Error("not implemented");
    },
    async updateInterface() {
      throw new Error("not implemented");
    },
  };
}

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
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

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "recording-start-route@example.com",
    groups: [],
    id: "user_recording_start_route",
    name: "Recording Start Route User",
    permissions: ["recording:create"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recordingSummary(overrides: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "Ad Hoc",
    healthStatus: "unknown",
    id: `rec_start_${randomUUID()}`,
    name: "Active Start Fixture",
    nodeId: "node_room_alpha",
    recordedAt: "2026-06-25T00:00:00.000Z",
    source: "ad_hoc",
    status: "recording",
    tags: ["voice"],
    ...overrides,
  };
}

function recorderNode(overrides: Partial<RecorderNode> = {}): RecorderNode {
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
      {
        alias: "Manual JACK Bus",
        backend: "jack",
        channelCount: 2,
        channels: [
          { alias: "Left", index: 1 },
          { alias: "Right", index: 2 },
        ],
        id: "iface_jack_manual",
        sampleRates: [48_000],
        systemName: "jack:manual",
        systemRef: "jack:manual",
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
    ...overrides,
  };
}

function flacProfile(overrides: Partial<RecordingProfile> = {}): RecordingProfile {
  return {
    bitrateKbps: 256,
    channelMode: "stereo",
    codec: "flac",
    id: "profile_flac",
    name: "FLAC Archive",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: false,
    ...overrides,
  };
}
