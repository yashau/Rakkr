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
    scopedNodes: async () => [],
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

test("recording metadata update saves and clears transcript snippets with audit snapshots", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const recordingStore = memoryRecordingStore([
    recording({
      id: "rec_transcript_snippets",
      name: "Transcript Snippets Test",
      transcriptSnippets: ["Initial public comment"],
    }),
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
    scopedNodes: async () => [],
    scopedRecordings: () => recordingStore.list(),
    settingsStore: {},
  });

  const saveResponse = await app.request("/api/v1/recordings/rec_transcript_snippets/metadata", {
    body: JSON.stringify({
      transcriptSnippets: [
        "  motion passed unanimously  ",
        "budget hearing continued",
        "Motion passed unanimously",
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const saveBody = (await saveResponse.json()) as { data: RecordingSummary };
  const clearResponse = await app.request("/api/v1/recordings/rec_transcript_snippets/metadata", {
    body: JSON.stringify({ transcriptSnippets: [] }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const clearBody = (await clearResponse.json()) as { data: RecordingSummary };
  const stored = await recordingStore.find("rec_transcript_snippets");
  const events = await auditStore.list({ action: "recordings.metadata.update.succeeded" });

  assert.equal(saveResponse.status, 200);
  assert.equal(clearResponse.status, 200);
  assert.equal(permissionCalls.at(-1)?.permission, "recording:edit");
  assert.equal(saveBody.data.transcriptSnippets?.length, 2);
  assert.deepEqual(saveBody.data.transcriptSnippets, [
    "motion passed unanimously",
    "budget hearing continued",
  ]);
  assert.equal(clearBody.data.transcriptSnippets, undefined);
  assert.equal(stored?.transcriptSnippets, undefined);
  assert.deepEqual(
    events.map((event) => event.details.fields),
    [["transcriptSnippets"], ["transcriptSnippets"]],
  );
  assert.deepEqual(
    (events[1]?.before as { transcriptSnippets?: string[] } | undefined)?.transcriptSnippets,
    ["Initial public comment"],
  );
  assert.deepEqual(
    (events[1]?.after as { transcriptSnippets?: string[] } | undefined)?.transcriptSnippets,
    ["motion passed unanimously", "budget hearing continued"],
  );
  assert.deepEqual(
    (events[0]?.before as { transcriptSnippets?: string[] } | undefined)?.transcriptSnippets,
    events[1]?.after?.transcriptSnippets,
  );
  assert.equal(
    (events[0]?.after as { transcriptSnippets?: string[] } | undefined)?.transcriptSnippets,
    undefined,
  );
});

test("bulk recording metadata update uses scoped recording context for snapshots", async () => {
  const auditStore = createAuditStore("");
  const recordingStore = memoryRecordingStore([
    recording({
      folder: "Raw Hidden Folder",
      id: "rec_scoped_bulk",
      tags: ["raw-hidden"],
    }),
  ]);
  const scopedRecording = recording({
    folder: "Scoped Folder",
    id: "rec_scoped_bulk",
    tags: ["scoped-visible"],
  });
  const app = new Hono<AppBindings>();

  registerRecordingRoutes({
    app,
    currentAuth: () => ({ user: currentUser() }),
    currentUser,
    nodeStore: {},
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission([]),
    scopedNodes: async () => [],
    scopedRecordings: async () => [scopedRecording],
    settingsStore: {},
  });

  const response = await app.request("/api/v1/recordings/bulk-metadata", {
    body: JSON.stringify({
      addTags: ["reviewed"],
      folder: "Scoped Updated",
      recordingIds: ["rec_scoped_bulk"],
    }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const body = (await response.json()) as { data: RecordingSummary[] };
  const stored = await recordingStore.find("rec_scoped_bulk");
  const [event] = await auditStore.list({ action: "recordings.metadata.bulk_update.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(body.data[0]?.folder, "Scoped Updated");
  assert.deepEqual(body.data[0]?.tags, ["scoped-visible", "reviewed"]);
  assert.equal(stored?.folder, "Scoped Updated");
  assert.deepEqual(stored?.tags, ["scoped-visible", "reviewed"]);
  assert.equal(
    (event?.before?.recordings as Array<{ folder: string; id: string }> | undefined)?.[0]?.folder,
    "Scoped Folder",
  );
  assert.deepEqual(
    (event?.before?.recordings as Array<{ tags: string[] }> | undefined)?.[0]?.tags,
    ["scoped-visible"],
  );
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
