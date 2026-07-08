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
    body: JSON.stringify({ nodeId: node.id, uploadPolicyIds: ["policy_missing"] }),
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
