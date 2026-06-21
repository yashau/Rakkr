import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { defaultVoiceRecordingProfile } from "@rakkr/shared";
import type { AuditEvent, CurrentUser, RecordingSummary } from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

process.env.DATABASE_URL = "";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

test("single recording action routes only operate on scoped recordings", async () => {
  const visible = recording({ id: "rec_visible_action", name: "Visible Action" });
  const hidden = recording({
    cached: true,
    folder: "Hidden",
    id: "rec_hidden_action",
    name: "Hidden Action",
    notes: "do not touch",
    status: "completed",
    tags: ["hidden"],
  });
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([visible, hidden]);
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: allowPermission,
    scopedNodes: async () => [],
    scopedRecordings: async () => [visible],
    settingsStore: memorySettingsStore(),
  });

  const playback = await app.request(`/api/v1/recordings/${hidden.id}/playback`, {
    method: "POST",
  });
  const download = await app.request(`/api/v1/recordings/${hidden.id}/download`, {
    method: "POST",
  });
  const stream = await app.request(`/api/v1/recordings/${hidden.id}/stream`);
  const file = await app.request(`/api/v1/recordings/${hidden.id}/file`);
  const metadata = await app.request(`/api/v1/recordings/${hidden.id}/metadata`, {
    body: JSON.stringify({ folder: "Mutated", notes: "changed", tags: ["changed"] }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const stop = await app.request(`/api/v1/recordings/${hidden.id}/stop`, { method: "POST" });
  const deleted = await app.request(`/api/v1/recordings/${hidden.id}`, { method: "DELETE" });
  const stored = await recordingStore.find(hidden.id);
  const failedEvents = await auditStore.list({ outcome: "failed" });

  assert.deepEqual(
    [
      playback.status,
      download.status,
      stream.status,
      file.status,
      metadata.status,
      stop.status,
      deleted.status,
    ],
    [404, 404, 404, 404, 404, 404, 404],
  );
  assert.equal(stored?.folder, "Hidden");
  assert.equal(stored?.notes, "do not touch");
  assert.equal(stored?.status, "completed");
  assert.deepEqual(stored?.tags, ["hidden"]);
  assert.deepEqual(failedEvents.map((event) => `${event.action}:${event.reason}`).sort(), [
    "recordings.delete.failed:recording_not_found",
    "recordings.download.failed:recording_not_found",
    "recordings.download.file.failed:recording_not_found",
    "recordings.metadata.update.failed:recording_not_found",
    "recordings.playback.failed:recording_not_found",
    "recordings.playback.stream.failed:recording_not_found",
    "recordings.stop.failed:recording_not_found",
  ]);
});

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "recording-scoped-action@example.com",
    groups: [],
    id: "user_recording_scoped_action",
    name: "Recording Scoped Action",
    permissions: [
      "recording:control",
      "recording:delete",
      "recording:download",
      "recording:edit",
      "recording:playback",
      "recording:read",
    ],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_recording_scoped_action",
        name: "Recording Scoped Action",
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

function memorySettingsStore(): SettingsStore {
  return {
    async findRecordingProfile() {
      return defaultVoiceRecordingProfile;
    },
    async listRecordingProfiles() {
      return [defaultVoiceRecordingProfile];
    },
  } as unknown as SettingsStore;
}

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: "rec_scoped_action",
    name: "Scoped Action Recording",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: ["voice"],
    ...input,
  };
}
