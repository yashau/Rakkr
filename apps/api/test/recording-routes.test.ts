import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(routeRoot, "recording-cache");
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(routeRoot, "upload-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

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

test("recording detail route returns scoped recordings only", async () => {
  const visible = recording({ id: "rec_visible_detail", name: "Visible Detail" });
  const hidden = recording({ id: "rec_hidden_detail", name: "Hidden Detail" });
  const permissionCalls: PermissionCall[] = [];
  const app = recordingApp({
    auditStore: createAuditStore(""),
    nodes: [recorderNode()],
    permissionCalls,
    profiles: [defaultVoiceRecordingProfile],
    recordingStore: memoryRecordingStore([visible, hidden]),
    visibleRecordingIds: [visible.id],
  });

  const visibleResponse = await app.request(`/api/v1/recordings/${visible.id}`);
  const hiddenResponse = await app.request(`/api/v1/recordings/${hidden.id}`);
  const missingResponse = await app.request("/api/v1/recordings/rec_missing_detail");
  const visibleBody = (await visibleResponse.json()) as { data: RecordingSummary };

  assert.equal(visibleResponse.status, 200);
  assert.equal(visibleBody.data.id, visible.id);
  assert.equal(hiddenResponse.status, 404);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(permissionCalls.at(-3), {
    action: "recordings.detail.read",
    permission: "recording:read",
    target: { id: visible.id, type: "recording" },
  });
  assert.deepEqual(permissionCalls.at(-2), {
    action: "recordings.detail.read",
    permission: "recording:read",
    target: { id: hidden.id, type: "recording" },
  });
  assert.deepEqual(permissionCalls.at(-1), {
    action: "recordings.detail.read",
    permission: "recording:read",
    target: { id: "rec_missing_detail", type: "recording" },
  });
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

test("bulk metadata update organizes visible recordings and audits snapshots", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({
      folder: "Inbox",
      id: "rec_bulk_a",
      name: "Bulk A",
      tags: ["voice", "raw"],
    }),
    recording({
      folder: "Inbox",
      id: "rec_bulk_b",
      name: "Bulk B",
      tags: ["planning"],
    }),
    recording({
      folder: "Inbox",
      id: "rec_bulk_c",
      name: "Bulk C",
      tags: ["untouched"],
    }),
  ]);
  const permissionCalls: PermissionCall[] = [];
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls,
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings/bulk-metadata", {
    body: JSON.stringify({
      addTags: ["reviewed", "voice"],
      folder: "Meetings/Council",
      recordingIds: ["rec_bulk_a", "rec_bulk_b", "rec_bulk_a"],
      removeTags: ["raw"],
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as {
    data: RecordingSummary[];
    meta: { updatedCount: number };
  };
  const updatedA = await recordingStore.find("rec_bulk_a");
  const updatedB = await recordingStore.find("rec_bulk_b");
  const untouched = await recordingStore.find("rec_bulk_c");
  const [event] = await auditStore.list({ action: "recordings.metadata.bulk_update.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:edit");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.metadata.bulk_update");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "recording_collection",
    type: "recording_collection",
  });
  assert.equal(body.meta.updatedCount, 2);
  assert.deepEqual(
    body.data.map((recording) => recording.id),
    ["rec_bulk_a", "rec_bulk_b"],
  );
  assert.equal(updatedA?.folder, "Meetings/Council");
  assert.deepEqual(updatedA?.tags, ["voice", "reviewed"]);
  assert.equal(updatedB?.folder, "Meetings/Council");
  assert.deepEqual(updatedB?.tags, ["planning", "reviewed", "voice"]);
  assert.equal(untouched?.folder, "Inbox");
  assert.deepEqual(untouched?.tags, ["untouched"]);
  assert.deepEqual(event?.details.fields, ["folder", "addTags", "removeTags"]);
  assert.equal(event?.details.requestedCount, 3);
  assert.equal(event?.details.updatedCount, 2);
  assert.equal(event?.permission, "recording:edit");
  assert.equal(event?.target.type, "recording_collection");
  assert.equal(
    (event?.before?.recordings as Array<{ folder: string; id: string }> | undefined)?.[0]?.folder,
    "Inbox",
  );
  assert.equal(
    (event?.after?.recordings as Array<{ folder: string; id: string }> | undefined)?.[0]?.folder,
    "Meetings/Council",
  );
});

test("bulk metadata update rejects recordings outside scoped visibility", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({ folder: "Visible", id: "rec_visible", tags: ["voice"] }),
    recording({ folder: "Hidden", id: "rec_hidden", tags: ["blocked"] }),
  ]);
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
    visibleRecordingIds: ["rec_visible"],
  });

  const response = await app.request("/api/v1/recordings/bulk-metadata", {
    body: JSON.stringify({
      folder: "Meetings/Restricted",
      recordingIds: ["rec_visible", "rec_hidden"],
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const visible = await recordingStore.find("rec_visible");
  const hidden = await recordingStore.find("rec_hidden");
  const [event] = await auditStore.list({ action: "recordings.metadata.bulk_update.failed" });

  assert.equal(response.status, 404);
  assert.equal(visible?.folder, "Visible");
  assert.equal(hidden?.folder, "Hidden");
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "recording_not_visible");
  assert.deepEqual(event?.details.hiddenIds, ["rec_hidden"]);
});

test("bulk recording delete removes terminal recordings and audits one snapshot", async () => {
  const auditStore = createAuditStore("");
  const cachePath = "ad-hoc/rec_bulk_delete_cached.mp3";
  const cacheFilePath = path.join(routeRoot, "recording-cache", cachePath);
  const recordingStore = memoryRecordingStore([
    recording({
      cached: true,
      cachePath,
      id: "rec_bulk_delete_cached",
      status: "cached",
    }),
    recording({ id: "rec_bulk_delete_terminal", status: "completed" }),
    recording({ id: "rec_bulk_delete_keep", status: "completed" }),
  ]);
  const permissionCalls: PermissionCall[] = [];
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls,
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, Buffer.from("cached audio"));

  const response = await app.request("/api/v1/recordings/bulk-delete", {
    body: JSON.stringify({
      recordingIds: [
        "rec_bulk_delete_cached",
        "rec_bulk_delete_terminal",
        "rec_bulk_delete_cached",
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as {
    data: RecordingSummary[];
    meta: { cacheDeletedCount: number; deletedCount: number };
  };
  const deletedCached = await recordingStore.find("rec_bulk_delete_cached");
  const deletedTerminal = await recordingStore.find("rec_bulk_delete_terminal");
  const kept = await recordingStore.find("rec_bulk_delete_keep");
  const [event] = await auditStore.list({ action: "recordings.bulk_delete.succeeded" });
  const before = event?.before as { recordings?: RecordingSummary[] } | undefined;

  assert.equal(response.status, 200);
  assert.equal(deletedCached, undefined);
  assert.equal(deletedTerminal, undefined);
  assert.equal(kept?.id, "rec_bulk_delete_keep");
  await assert.rejects(
    readFile(cacheFilePath),
    (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  assert.equal(permissionCalls.at(-1)?.permission, "recording:delete");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.bulk_delete");
  assert.equal(body.meta.deletedCount, 2);
  assert.equal(body.meta.cacheDeletedCount, 1);
  assert.deepEqual(
    body.data.map((recording) => recording.id),
    ["rec_bulk_delete_cached", "rec_bulk_delete_terminal"],
  );
  assert.equal(event?.permission, "recording:delete");
  assert.equal(event?.target.type, "recording_collection");
  assert.equal(event?.details.requestedCount, 3);
  assert.equal(event?.details.deletedCount, 2);
  assert.equal(before?.recordings?.[0]?.id, "rec_bulk_delete_cached");
});

test("bulk recording delete rejects hidden recordings", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({ id: "rec_bulk_delete_visible", status: "completed" }),
    recording({ id: "rec_bulk_delete_hidden", status: "completed" }),
  ]);
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
    visibleRecordingIds: ["rec_bulk_delete_visible"],
  });

  const response = await app.request("/api/v1/recordings/bulk-delete", {
    body: JSON.stringify({
      recordingIds: ["rec_bulk_delete_visible", "rec_bulk_delete_hidden"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const visible = await recordingStore.find("rec_bulk_delete_visible");
  const hidden = await recordingStore.find("rec_bulk_delete_hidden");
  const [event] = await auditStore.list({ action: "recordings.bulk_delete.failed" });

  assert.equal(response.status, 404);
  assert.equal(visible?.id, "rec_bulk_delete_visible");
  assert.equal(hidden?.id, "rec_bulk_delete_hidden");
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.reason, "recording_not_visible");
  assert.deepEqual(event?.details.hiddenIds, ["rec_bulk_delete_hidden"]);
});

test("bulk recording delete rejects active recordings before deleting anything", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({ id: "rec_bulk_delete_ready", status: "completed" }),
    recording({ id: "rec_bulk_delete_active", status: "recording" }),
  ]);
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings/bulk-delete", {
    body: JSON.stringify({
      recordingIds: ["rec_bulk_delete_ready", "rec_bulk_delete_active"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const ready = await recordingStore.find("rec_bulk_delete_ready");
  const active = await recordingStore.find("rec_bulk_delete_active");
  const [event] = await auditStore.list({ action: "recordings.bulk_delete.failed" });

  assert.equal(response.status, 409);
  assert.equal(ready?.id, "rec_bulk_delete_ready");
  assert.equal(active?.id, "rec_bulk_delete_active");
  assert.equal(event?.reason, "recording_active");
  assert.deepEqual(event?.details.activeIds, ["rec_bulk_delete_active"]);
});

test("recording delete removes terminal metadata cached file and audits snapshot", async () => {
  const auditStore = createAuditStore("");
  const cachePath = "ad-hoc/rec_delete_cached.mp3";
  const cacheFilePath = path.join(routeRoot, "recording-cache", cachePath);
  const recordingStore = memoryRecordingStore([
    recording({
      cached: true,
      cachePath,
      id: "rec_delete_cached",
      name: "Delete Cached Recording",
      status: "cached",
    }),
  ]);
  const permissionCalls: PermissionCall[] = [];
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls,
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, Buffer.from("cached audio"));

  const response = await app.request("/api/v1/recordings/rec_delete_cached", {
    method: "DELETE",
  });
  const stored = await recordingStore.find("rec_delete_cached");
  const [event] = await auditStore.list({ action: "recordings.delete.succeeded" });
  const before = event?.before as { recording?: RecordingSummary } | undefined;

  assert.equal(response.status, 204);
  assert.equal(stored, undefined);
  await assert.rejects(
    readFile(cacheFilePath),
    (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  assert.equal(permissionCalls.at(-1)?.permission, "recording:delete");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.delete");
  assert.deepEqual(permissionCalls.at(-1)?.target, {
    id: "rec_delete_cached",
    type: "recording",
  });
  assert.equal(event?.permission, "recording:delete");
  assert.equal(event?.target.id, "rec_delete_cached");
  assert.equal(event?.details.cacheDeleted, true);
  assert.equal(event?.details.cached, true);
  assert.equal(before?.recording?.id, "rec_delete_cached");
});

test("recording delete rejects active recordings and audits failure", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({
      id: "rec_delete_active",
      name: "Active Recording",
      status: "recording",
    }),
  ]);
  const app = recordingApp({
    auditStore,
    nodes: [recorderNode()],
    permissionCalls: [],
    profiles: [defaultVoiceRecordingProfile],
    recordingStore,
  });

  const response = await app.request("/api/v1/recordings/rec_delete_active", {
    method: "DELETE",
  });
  const stored = await recordingStore.find("rec_delete_active");
  const [event] = await auditStore.list({ action: "recordings.delete.failed" });

  assert.equal(response.status, 409);
  assert.equal(stored?.id, "rec_delete_active");
  assert.equal(event?.permission, "recording:delete");
  assert.equal(event?.reason, "recording_active");
  assert.equal(event?.target.id, "rec_delete_active");
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

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
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
