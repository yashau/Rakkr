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

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(routeRoot, "upload-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording facets summarize visible library relationships", async () => {
  const auditStore = createAuditStore("");
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore([
      recording({
        folder: "Meetings/Council",
        id: "rec_1",
        nodeId: "node_a",
        recordingProfileId: "profile_voice",
        tags: ["voice", "council"],
        trackGroupId: "track_1",
        uploadPolicyId: "upload_a",
      }),
      recording({
        folder: "Meetings/Council",
        id: "rec_2",
        nodeId: "node_a",
        recordingProfileId: "profile_voice",
        tags: ["voice"],
        uploadPolicyId: "upload_b",
      }),
      recording({
        folder: "Meetings/Planning",
        id: "rec_3",
        nodeId: "node_b",
        recordingProfileId: "profile_archive",
        tags: ["planning"],
        trackGroupId: "track_1",
        uploadPolicyId: "upload_b",
      }),
    ]),
  });

  const response = await app.request("/api/v1/recordings/facets");
  const body = (await response.json()) as {
    data: {
      folders: Array<{ count: number; value: string }>;
      nodes: Array<{ count: number; value: string }>;
      recordingProfiles: Array<{ count: number; value: string }>;
      tags: Array<{ count: number; value: string }>;
      trackGroups: Array<{ count: number; value: string }>;
      uploadPolicies: Array<{ count: number; value: string }>;
    };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(body.data.folders, [
    { count: 2, value: "Meetings/Council" },
    { count: 1, value: "Meetings/Planning" },
  ]);
  assert.deepEqual(body.data.tags, [
    { count: 2, value: "voice" },
    { count: 1, value: "council" },
    { count: 1, value: "planning" },
  ]);
  assert.deepEqual(body.data.nodes, [
    { count: 2, value: "node_a" },
    { count: 1, value: "node_b" },
  ]);
  assert.deepEqual(body.data.recordingProfiles, [
    { count: 2, value: "profile_voice" },
    { count: 1, value: "profile_archive" },
  ]);
  assert.deepEqual(body.data.trackGroups, [{ count: 2, value: "track_1" }]);
  assert.deepEqual(body.data.uploadPolicies, [
    { count: 2, value: "upload_b" },
    { count: 1, value: "upload_a" },
  ]);
});

test("recording list filters by recorded date range", async () => {
  const auditStore = createAuditStore("");
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore([
      recording({ id: "rec_old", recordedAt: "2026-06-17T23:59:59.000Z" }),
      recording({ id: "rec_target", recordedAt: "2026-06-18T12:00:00.000Z" }),
      recording({ id: "rec_new", recordedAt: "2026-06-19T00:00:01.000Z" }),
    ]),
  });
  const params = new URLSearchParams({
    recordedFrom: "2026-06-18T00:00:00.000Z",
    recordedTo: "2026-06-19T00:00:00.000Z",
  });

  const response = await app.request(`/api/v1/recordings?${params}`);
  const body = (await response.json()) as { data: RecordingSummary[] };
  const invalidResponse = await app.request("/api/v1/recordings?recordedFrom=not-a-date");

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((item) => item.id),
    ["rec_target"],
  );
  assert.equal(invalidResponse.status, 400);
});

test("recording list sorts by requested field and order", async () => {
  const auditStore = createAuditStore("");
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore([
      recording({
        durationSeconds: 60,
        id: "rec_alpha",
        name: "Alpha",
        recordedAt: "2026-06-18T11:00:00.000Z",
      }),
      recording({
        durationSeconds: 300,
        id: "rec_bravo",
        name: "Bravo",
        recordedAt: "2026-06-18T12:00:00.000Z",
      }),
      recording({
        durationSeconds: 120,
        id: "rec_charlie",
        name: "Charlie",
        recordedAt: "2026-06-18T10:00:00.000Z",
      }),
    ]),
  });

  const dateResponse = await app.request("/api/v1/recordings?sortBy=recordedAt&sortOrder=desc");
  const dateBody = (await dateResponse.json()) as { data: RecordingSummary[] };
  const nameResponse = await app.request("/api/v1/recordings?sortBy=name&sortOrder=asc");
  const nameBody = (await nameResponse.json()) as { data: RecordingSummary[] };
  const invalidResponse = await app.request("/api/v1/recordings?sortBy=unknown");

  assert.equal(dateResponse.status, 200);
  assert.deepEqual(
    dateBody.data.map((item) => item.id),
    ["rec_bravo", "rec_alpha", "rec_charlie"],
  );
  assert.equal(nameResponse.status, 200);
  assert.deepEqual(
    nameBody.data.map((item) => item.id),
    ["rec_alpha", "rec_bravo", "rec_charlie"],
  );
  assert.equal(invalidResponse.status, 400);
});

test("recording list paginates sorted results", async () => {
  const auditStore = createAuditStore("");
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore([
      recording({ id: "rec_1", name: "Alpha" }),
      recording({ id: "rec_2", name: "Bravo" }),
      recording({ id: "rec_3", name: "Charlie" }),
      recording({ id: "rec_4", name: "Delta" }),
    ]),
  });

  const response = await app.request(
    "/api/v1/recordings?sortBy=name&sortOrder=asc&limit=2&offset=1",
  );
  const body = (await response.json()) as {
    data: RecordingSummary[];
    meta: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      limit: number;
      offset: number;
      returned: number;
      total: number;
    };
  };
  const invalidResponse = await app.request("/api/v1/recordings?limit=0");

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((item) => item.id),
    ["rec_2", "rec_3"],
  );
  assert.deepEqual(body.meta, {
    hasNextPage: true,
    hasPreviousPage: true,
    limit: 2,
    offset: 1,
    returned: 2,
    total: 4,
  });
  assert.equal(invalidResponse.status, 400);
});

test("recording list filters by profile upload policy and track group", async () => {
  const auditStore = createAuditStore("");
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore([
      recording({
        id: "rec_default",
        recordingProfileId: defaultVoiceRecordingProfile.id,
        uploadPolicyId: "upload-policy-stub",
      }),
      recording({
        id: "rec_archive",
        recordingProfileId: "profile_archive",
        trackGroupId: "track_group_archive",
        uploadPolicyId: "upload-policy-archive",
      }),
      recording({
        id: "rec_manual",
        recordingProfileId: "profile_archive",
        trackGroupId: "track_group_manual",
        uploadPolicyId: "upload-policy-manual",
      }),
    ]),
  });
  const filteredParams = new URLSearchParams({
    recordingProfileId: "profile_archive",
    trackGroupId: "track_group_archive",
    uploadPolicyId: "upload-policy-archive",
  });
  const searchParams = new URLSearchParams({ search: "track_group_manual" });

  const filteredResponse = await app.request(`/api/v1/recordings?${filteredParams}`);
  const filteredBody = (await filteredResponse.json()) as { data: RecordingSummary[] };
  const searchResponse = await app.request(`/api/v1/recordings?${searchParams}`);
  const searchBody = (await searchResponse.json()) as { data: RecordingSummary[] };

  assert.equal(filteredResponse.status, 200);
  assert.deepEqual(
    filteredBody.data.map((item) => item.id),
    ["rec_archive"],
  );
  assert.equal(searchResponse.status, 200);
  assert.deepEqual(
    searchBody.data.map((item) => item.id),
    ["rec_manual"],
  );
});

test("ad hoc recording start uses requested node profile policy and metadata", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore();
  const permissionCalls: PermissionCall[] = [];
  const profile = flacProfile();
  const node = recorderNode();
  const policy = await createUploadPolicy({
    enabled: true,
    id: "upload-policy-adhoc-flac",
    maxAttempts: 2,
    name: "Ad Hoc FLAC Archive",
    provider: "s3",
    target: "s3://rakkr-archive/ad-hoc",
    trigger: "manual",
  });
  const app = recordingApp({
    auditStore,
    nodes: [node],
    permissionCalls,
    profiles: [profile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings", {
    body: JSON.stringify({
      folder: "Ad Hoc/Manual",
      name: "Manual Capture",
      nodeId: node.id,
      recordingProfileId: profile.id,
      tags: ["voice", "Voice", "council"],
      uploadPolicyId: policy.id,
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
  assert.equal(permissionCalls.at(-1)?.permission, "recording:create");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.start");
  assert.deepEqual(permissionCalls.at(-1)?.target, { id: node.id, type: "node" });
  assert.equal(body.data.id, stored?.id);
  assert.equal(body.data.folder, "Ad Hoc/Manual");
  assert.equal(body.data.name, "Manual Capture");
  assert.equal(body.data.nodeId, node.id);
  assert.equal(body.data.recordingProfileId, profile.id);
  assert.deepEqual(body.data.tags, ["voice", "council"]);
  assert.equal(body.data.uploadPolicyId, policy.id);
  assert.equal(body.job.nodeId, node.id);
  assert.equal(body.job.command.captureInterfaceId, "iface_usb_1");
  assert.equal(body.job.command.outputCodec, "flac");
  assert.equal(body.job.command.outputFileName, `${body.data.id}.flac`);
  assert.equal(event?.details.profileId, profile.id);
  assert.equal(event?.target.id, body.data.id);
});

test("ad hoc recording start audits missing dependencies", async () => {
  const auditStore = createAuditStore("");
  const node = recorderNode();
  const app = recordingApp({
    auditStore,
    nodes: [node],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore(),
  });

  const missingNode = await app.request("/api/v1/recordings", {
    body: JSON.stringify({ nodeId: "node_missing" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const missingProfile = await app.request("/api/v1/recordings", {
    body: JSON.stringify({ nodeId: node.id, recordingProfileId: "profile_missing" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const missingPolicy = await app.request("/api/v1/recordings", {
    body: JSON.stringify({ nodeId: node.id, uploadPolicyId: "policy_missing" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const events = await auditStore.list({ action: "recordings.start.failed" });

  assert.equal(missingNode.status, 404);
  assert.equal(missingProfile.status, 404);
  assert.equal(missingPolicy.status, 404);
  assert.deepEqual(
    events.map((event) => event.reason),
    ["upload_policy_not_found", "recording_profile_not_found", "node_not_found"],
  );
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function recordingApp({
  auditStore,
  nodes,
  permissionCalls,
  profiles,
  recordingStore,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
  profiles: RecordingProfile[];
  recordingStore: RecordingStore;
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
    scopedRecordings: () => recordingStore.list(),
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

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
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

function recorderNode(): RecorderNode {
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

function recording(input: Partial<RecordingSummary>): RecordingSummary {
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

function flacProfile(): RecordingProfile {
  return {
    bitrateKbps: 256,
    channelMode: "stereo",
    codec: "flac",
    id: "profile_flac",
    name: "FLAC Archive",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: false,
  };
}
