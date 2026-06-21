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

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-recording-export-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(routeRoot, "recording-cache");
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(routeRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(routeRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("recording export returns scoped filtered manifest and audits access", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = recordingExportApp({
    auditStore,
    permissionCalls,
    recordingStore: memoryRecordingStore([
      recording({
        folder: "Meetings, Council",
        id: "rec_visible",
        name: 'Visible "Council" Recording',
        nodeId: "node_a",
        notes: "Marked for clerk review",
        tags: ["voice", "council"],
        transcriptSnippets: ["Mayor calls roll", "Motion, seconded"],
      }),
      recording({ id: "rec_filtered_out", nodeId: "node_a", tags: ["planning"] }),
      recording({ id: "rec_hidden", nodeId: "node_b", tags: ["voice"] }),
    ]),
    visibleRecordingIds: ["rec_visible", "rec_filtered_out"],
  });

  const response = await app.request("/api/v1/recordings/export?tag=voice&sortBy=name");
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "recordings.export.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.export");
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(response.headers.get("content-disposition") ?? "", /rakkr-recordings-/);
  assert.match(
    csv,
    /^id,name,notes,transcriptSnippets,folder,tags,status,healthStatus,source,recordedAt/m,
  );
  assert.match(
    csv,
    /rec_visible,"Visible ""Council"" Recording",Marked for clerk review,"Mayor calls roll \| Motion, seconded","Meetings, Council",voice;council/,
  );
  assert.doesNotMatch(csv, /rec_filtered_out/);
  assert.doesNotMatch(csv, /rec_hidden/);
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.details.exportedCount, 1);
  assert.deepEqual(event?.details.filters, { sortBy: "name", tag: "voice" });
});

test("selected recording export preserves requested order and audits selection", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = recordingExportApp({
    auditStore,
    permissionCalls,
    recordingStore: memoryRecordingStore([
      recording({ id: "rec_first", name: "First", tags: ["one"] }),
      recording({ id: "rec_second", name: "Second", tags: ["two"] }),
      recording({ id: "rec_hidden", name: "Hidden" }),
    ]),
    visibleRecordingIds: ["rec_first", "rec_second"],
  });

  const response = await app.request("/api/v1/recordings/export", {
    body: JSON.stringify({ recordingIds: ["rec_second", "rec_first", "rec_second"] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "recordings.export_selected.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.export_selected");
  assert.match(response.headers.get("content-disposition") ?? "", /rakkr-recordings-/);
  assert.ok(csv.indexOf("rec_second") < csv.indexOf("rec_first"));
  assert.doesNotMatch(csv, /rec_hidden/);
  assert.equal(event?.permission, "recording:read");
  assert.equal(event?.details.exportedCount, 2);
  assert.equal(event?.details.requestedCount, 3);
  assert.equal(event?.correlationIds?.recordingId1, "rec_second");
  assert.equal(event?.correlationIds?.recordingId2, "rec_first");
});

test("selected recording export rejects recordings outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = recordingExportApp({
    auditStore,
    permissionCalls,
    recordingStore: memoryRecordingStore([
      recording({ id: "rec_visible", name: "Visible" }),
      recording({ id: "rec_hidden", name: "Hidden" }),
    ]),
    visibleRecordingIds: ["rec_visible"],
  });

  const response = await app.request("/api/v1/recordings/export", {
    body: JSON.stringify({ recordingIds: ["rec_visible", "rec_hidden"] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "recordings.export_selected.failed" });

  assert.equal(response.status, 404);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:read");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.export_selected");
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "recording_not_visible");
  assert.deepEqual(event?.details.hiddenIds, ["rec_hidden"]);
  assert.deepEqual(event?.details.recordingIds, ["rec_visible", "rec_hidden"]);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function recordingExportApp({
  auditStore,
  permissionCalls,
  recordingStore,
  visibleRecordingIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  permissionCalls: PermissionCall[];
  recordingStore: RecordingStore;
  visibleRecordingIds: string[];
}) {
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser() }),
    currentUser,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => [],
    scopedRecordings: async () =>
      (await recordingStore.list()).filter((recording) =>
        visibleRecordingIds.includes(recording.id),
      ),
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
    const user = currentUser();
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

function currentUser(): CurrentUser {
  return {
    email: "recording-export@example.com",
    groups: [],
    id: "user_recording_export",
    name: "Recording Export User",
    permissions: ["recording:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
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
