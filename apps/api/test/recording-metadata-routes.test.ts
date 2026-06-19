import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecordingSummary } from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";
import type { RecordingStore } from "../src/recording-store.js";

process.env.DATABASE_URL = "";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");

test("recording metadata update saves and clears operator notes with audit snapshots", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recordingStore = memoryRecordingStore([
    recording({ id: "rec_notes", name: "Notes Test", notes: "Initial operator note" }),
  ]);
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser() }),
    currentUser,
    nodeStore: {},
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(permissionCalls),
    scopedRecordings: () => recordingStore.list(),
    settingsStore: {},
  });

  const saveResponse = await app.request("/api/v1/recordings/rec_notes/metadata", {
    body: JSON.stringify({ notes: "  Needs review after council packet update  " }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const saveBody = (await saveResponse.json()) as { data: RecordingSummary };
  const clearResponse = await app.request("/api/v1/recordings/rec_notes/metadata", {
    body: JSON.stringify({ notes: null }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const clearBody = (await clearResponse.json()) as { data: RecordingSummary };
  const stored = await recordingStore.find("rec_notes");
  const events = await auditStore.list({ action: "recordings.metadata.update.succeeded" });

  assert.equal(saveResponse.status, 200);
  assert.equal(clearResponse.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:edit");
  assert.equal(permissionCalls.at(-1)?.action, "recordings.metadata.update");
  assert.equal(saveBody.data.notes, "Needs review after council packet update");
  assert.equal(clearBody.data.notes, undefined);
  assert.equal(stored?.notes, undefined);
  assert.deepEqual(
    events.map((event) => event.details.fields),
    [["notes"], ["notes"]],
  );
  assert.equal(
    (events[1]?.before as { notes?: string } | undefined)?.notes,
    "Initial operator note",
  );
  assert.equal(
    (events[1]?.after as { notes?: string } | undefined)?.notes,
    "Needs review after council packet update",
  );
  assert.equal(
    (events[0]?.before as { notes?: string } | undefined)?.notes,
    events[1]?.after?.notes,
  );
  assert.equal((events[0]?.after as { notes?: string } | undefined)?.notes, undefined);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
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
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_recording_notes",
        name: "Recording Notes User",
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

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
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

function currentUser(): CurrentUser {
  return {
    email: "recording-notes@example.com",
    groups: [],
    id: "user_recording_notes",
    name: "Recording Notes User",
    permissions: ["recording:edit"],
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
