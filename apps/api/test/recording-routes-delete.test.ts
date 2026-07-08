import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type { RecordingSummary } from "@rakkr/shared";
import {
  createAuditStore,
  memoryRecordingStore,
  recorderNode,
  recording,
  recordingApp,
  routeRoot,
} from "./recording-routes-harness.js";
import type { PermissionCall } from "./recording-routes-harness.js";

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
