import assert from "node:assert/strict";
import test from "node:test";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type { RecordingSummary } from "@rakkr/shared";
import {
  createAuditStore,
  memoryRecordingStore,
  recorderNode,
  recording,
  recordingApp,
} from "./recording-routes-harness.js";
import type { PermissionCall } from "./recording-routes-harness.js";

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
        uploadPolicyIds: ["upload_a"],
      }),
      recording({
        folder: "Meetings/Council",
        id: "rec_2",
        nodeId: "node_a",
        recordingProfileId: "profile_voice",
        tags: ["voice"],
        uploadPolicyIds: ["upload_b"],
      }),
      recording({
        folder: "Meetings/Planning",
        id: "rec_3",
        nodeId: "node_b",
        recordingProfileId: "profile_archive",
        tags: ["planning"],
        trackGroupId: "track_1",
        uploadPolicyIds: ["upload_b"],
      }),
    ]),
  });

  const response = await app.request("/api/v1/recordings/facets");
  const [event] = await auditStore.list({ action: "recordings.facets.read.succeeded" });
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
  assert.equal(event?.target.id, "recording_collection");
  assert.equal(event?.details.recordingCount, 3);
  assert.equal(event?.details.tagCount, 3);
});

test("recording detail route returns scoped recordings only", async () => {
  const auditStore = createAuditStore("");
  const visible = recording({ id: "rec_visible_detail", name: "Visible Detail" });
  const hidden = recording({ id: "rec_hidden_detail", name: "Hidden Detail" });
  const permissionCalls: PermissionCall[] = [];
  const app = recordingApp({
    auditStore,
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
  const [successEvent] = await auditStore.list({ action: "recordings.detail.read.succeeded" });
  const failedEvents = await auditStore.list({ action: "recordings.detail.read.failed" });

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
  assert.equal(successEvent?.target.id, visible.id);
  assert.equal(successEvent?.details.status, visible.status);
  assert.deepEqual(failedEvents.map((event) => [event.target.id, event.reason]).sort(), [
    [hidden.id, "recording_not_found"],
    ["rec_missing_detail", "recording_not_found"],
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
  const [successEvent] = await auditStore.list({ action: "recordings.read.succeeded" });
  const [failedEvent] = await auditStore.list({ action: "recordings.read.failed" });

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((item) => item.id),
    ["rec_target"],
  );
  assert.equal(invalidResponse.status, 400);
  assert.equal(successEvent?.target.id, "recording_collection");
  assert.equal(successEvent?.details.returnedCount, 1);
  assert.equal(successEvent?.details.totalCount, 1);
  assert.equal(failedEvent?.reason, "invalid_filters");
  assert.equal(failedEvent?.details.issueCount, 1);
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
        uploadPolicyIds: ["upload-policy-stub"],
      }),
      recording({
        id: "rec_archive",
        recordingProfileId: "profile_archive",
        trackGroupId: "track_group_archive",
        uploadPolicyIds: ["upload-policy-archive"],
      }),
      recording({
        id: "rec_manual",
        recordingProfileId: "profile_archive",
        trackGroupId: "track_group_manual",
        uploadPolicyIds: ["upload-policy-manual"],
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
