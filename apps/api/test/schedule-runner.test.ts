import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingJob,
  RecordingProfile,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput } from "../src/node-store.js";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-schedule-runner-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(runnerRoot, "jobs.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(runnerRoot, "cache");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(runnerRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(runnerRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { listRecordingJobs } = await import("../src/recording-jobs.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { runDueSchedules } = await import("../src/schedule-runner.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");

test.after(async () => {
  await rm(runnerRoot, { force: true, recursive: true });
});

test("due schedule creates ordered track jobs when profile has max track length", async () => {
  const recordingStore = memoryRecordingStore();
  const scheduleStore = memoryScheduleStore([schedule({ captureInterfaceId: "iface_jack_split" })]);
  const result = await runDueSchedules(
    {
      auditStore: createAuditStore(""),
      nodeStore: memoryNodeStore([node()]),
      recordingStore,
      scheduleStore,
      settingsStore: memorySettingsStore([splitProfile()]),
    },
    new Date("2026-06-18T09:00:00.000Z"),
  );
  const recordings = await recordingStore.list();
  const jobs = await listRecordingJobs();

  assert.equal(result[0]?.segmentCount, 3);
  assert.equal(recordings.length, 3);
  assert.deepEqual(
    recordings.map((recording) => ({
      durationSeconds: recording.durationSeconds,
      name: recording.name,
      trackIndex: recording.trackIndex,
      trackTotal: recording.trackTotal,
    })),
    [
      {
        durationSeconds: 0,
        name: "2026-06-18_1030_Council Meeting - Track 3 of 3",
        trackIndex: 3,
        trackTotal: 3,
      },
      {
        durationSeconds: 0,
        name: "2026-06-18_0945_Council Meeting - Track 2 of 3",
        trackIndex: 2,
        trackTotal: 3,
      },
      {
        durationSeconds: 0,
        name: "2026-06-18_0900_Council Meeting - Track 1 of 3",
        trackIndex: 1,
        trackTotal: 3,
      },
    ],
  );
  assert.deepEqual(
    jobs
      .map((job) => job.command)
      .sort((left, right) => (left.trackIndex ?? 0) - (right.trackIndex ?? 0))
      .map((command) => ({
        captureBackend: command.captureBackend,
        captureDevice: command.captureDevice,
        captureInterfaceId: command.captureInterfaceId,
        durationSeconds: command.durationSeconds,
        outputCodec: command.outputCodec,
        trackIndex: command.trackIndex,
        trackTotal: command.trackTotal,
      })),
    [
      {
        captureBackend: "jack",
        captureDevice: "jack:council",
        captureInterfaceId: "iface_jack_split",
        durationSeconds: 2_700,
        outputCodec: "mp3",
        trackIndex: 1,
        trackTotal: 3,
      },
      {
        captureBackend: "jack",
        captureDevice: "jack:council",
        captureInterfaceId: "iface_jack_split",
        durationSeconds: 2_700,
        outputCodec: "mp3",
        trackIndex: 2,
        trackTotal: 3,
      },
      {
        captureBackend: "jack",
        captureDevice: "jack:council",
        captureInterfaceId: "iface_jack_split",
        durationSeconds: 1_800,
        outputCodec: "mp3",
        trackIndex: 3,
        trackTotal: 3,
      },
    ],
  );
  assert.equal(new Set(recordings.map((recording) => recording.trackGroupId)).size, 1);
});

test("scheduled recording completes through agent cache attach and exposes schedule-owned media", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const recordingStore = memoryRecordingStore();
  const scheduledNode = node({
    alias: "Scheduled Lifecycle Node",
    id: `node_scheduled_lifecycle_${Date.now()}`,
  });
  const nodeStore = memoryNodeStore([scheduledNode]);
  const scheduledPolicy = await createUploadPolicy({
    enabled: true,
    id: `upload-policy-scheduled-lifecycle-${Date.now()}`,
    maxAttempts: 2,
    name: "Scheduled Lifecycle Auto Stub",
    provider: "stub",
    target: "stub://scheduled-lifecycle",
    trigger: "on_recording_cached",
  });
  const scheduled = schedule({
    id: `sched_lifecycle_${Date.now()}`,
    nodeId: scheduledNode.id,
    uploadPolicyId: scheduledPolicy.id,
  });
  const settingsStore = memorySettingsStore([splitProfile({ maxTrackSeconds: undefined })]);

  registerRecordingRoutes({
    app,
    currentAuth: () => auth(),
    currentUser: () => user(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    requirePermission: requirePermission(),
    scopedNodes: () => nodeStore.list(),
    scopedRecordings: () => recordingStore.list(),
    settingsStore,
  });
  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore,
  });

  const [result] = await runDueSchedules(
    {
      auditStore,
      nodeStore,
      recordingStore,
      scheduleStore: memoryScheduleStore([scheduled]),
      settingsStore,
    },
    new Date("2026-06-18T09:00:00.000Z"),
  );
  const [created] = await recordingStore.list();
  const next = await app.request(`/api/v1/nodes/${scheduledNode.id}/recording-jobs/next`, {
    headers: { authorization: "Bearer node-token" },
  });
  const nextBody = (await next.json()) as { data: RecordingJob };
  const claim = await app.request(`/api/v1/recording-jobs/${nextBody.data.id}/claim`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const attachBytes = wavFile([0, 16_000, -16_000, 8000]);
  const attached = await app.request(`/api/v1/recordings/${created?.id}/cache-file`, {
    body: attachBytes,
    headers: {
      authorization: "Bearer node-token",
      "content-type": "audio/wav",
      "x-rakkr-duration-seconds": "7200",
      "x-rakkr-file-name": "scheduled-lifecycle.wav",
      "x-rakkr-recording-job-id": nextBody.data.id,
    },
    method: "PUT",
  });
  const attachedBody = (await attached.json()) as {
    data: {
      recording: RecordingSummary;
      uploadQueueItem?: { recordingId: string; uploadPolicyId?: string };
    };
  };
  const stream = await app.request(`/api/v1/recordings/${created?.id}/stream`);
  const file = await app.request(`/api/v1/recordings/${created?.id}/file`);
  const [cacheAudit] = await auditStore.list({ action: "recordings.cache_file.attach.succeeded" });
  const dueRunEvents = await auditStore.list({ action: "schedules.due_run.succeeded" });
  const playback = await app.request(`/api/v1/recordings/${created?.id}/playback`, {
    method: "POST",
  });
  const download = await app.request(`/api/v1/recordings/${created?.id}/download`, {
    method: "POST",
  });

  assert.equal(result?.outcome, "succeeded");
  assert.equal(result?.recordingId, created?.id);
  assert.equal(next.status, 200);
  assert.equal(nextBody.data.recordingId, created?.id);
  assert.equal(claim.status, 200);
  assert.equal(attached.status, 201);
  assert.equal(attachedBody.data.recording.cachePath, `scheduled/${created?.id}.wav`);
  assert.equal(attachedBody.data.recording.durationSeconds, 7200);
  assert.equal(attachedBody.data.recording.folder, "Meetings/2026-06-18/Council Meeting");
  assert.equal(attachedBody.data.recording.name, "2026-06-18_0900_Council Meeting");
  assert.equal(attachedBody.data.recording.scheduleId, scheduled.id);
  assert.equal(attachedBody.data.recording.retentionPolicyId, scheduled.retentionPolicyId);
  assert.equal(attachedBody.data.recording.source, "schedule");
  assert.deepEqual(attachedBody.data.recording.tags, ["voice"]);
  assert.equal(attachedBody.data.recording.uploadPolicyId, scheduledPolicy.id);
  assert.equal(attachedBody.data.recording.watchdogPolicyId, "scheduled-voice-watchdog");
  assert.equal(attachedBody.data.uploadQueueItem?.uploadPolicyId, scheduledPolicy.id);
  assert.equal(playback.status, 202);
  assert.equal(download.status, 202);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "audio/wav");
  assert.equal((await stream.arrayBuffer()).byteLength, attachBytes.byteLength);
  assert.equal(file.status, 200);
  assert.equal(
    file.headers.get("content-disposition"),
    'attachment; filename="2026-06-18_0900_Council Meeting.wav"',
  );
  assert.equal(cacheAudit?.target.id, created?.id);
  assert.equal(cacheAudit?.details.jobStatus, "completed");
  assert.equal(dueRunEvents[0]?.after?.recordingId, created?.id);
});

function memoryRecordingStore(recordings: RecordingSummary[] = []) {
  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
    },
    async delete(recordingId: string) {
      const index = recordings.findIndex((recording) => recording.id === recordingId);

      if (index < 0) {
        return undefined;
      }

      const [deleted] = recordings.splice(index, 1);

      return deleted;
    },
    async find(recordingId: string) {
      return recordings.find((recording) => recording.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording: RecordingSummary) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);

      if (index >= 0) {
        recordings[index] = recording;
      }
    },
  };
}

function memoryScheduleStore(schedules: ScheduleSummary[]) {
  return {
    async create(schedule: ScheduleSummary) {
      schedules.unshift(schedule);

      return schedule;
    },
    async delete(scheduleId: string) {
      const index = schedules.findIndex((schedule) => schedule.id === scheduleId);
      const [deleted] = index >= 0 ? schedules.splice(index, 1) : [];

      return deleted;
    },
    async find(scheduleId: string) {
      return schedules.find((schedule) => schedule.id === scheduleId);
    },
    async list() {
      return schedules;
    },
    async update(scheduleId: string, update: Partial<Omit<ScheduleSummary, "id">>) {
      const index = schedules.findIndex((schedule) => schedule.id === scheduleId);

      if (index < 0) {
        return undefined;
      }

      schedules[index] = { ...schedules[index], ...update };

      return schedules[index];
    },
  };
}

function memoryNodeStore(nodes: RecorderNode[]) {
  return {
    async authenticateCredential(token: string) {
      return token === "node-token"
        ? {
            credentialId: "cred_schedule_runner_test",
            nodeId: nodes[0]?.id ?? "node_split",
            tokenPrefix: "node-token",
          }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId: string) {
      return nodes.find((node) => node.id === nodeId);
    },
    async heartbeat(nodeId: string, input: NodeHeartbeatInput) {
      const index = nodes.findIndex((candidate) => candidate.id === nodeId);

      if (index < 0) {
        return undefined;
      }

      nodes[index] = {
        ...nodes[index],
        agentVersion: input.agentVersion,
        hostname: input.hostname,
        ipAddresses: input.ipAddresses,
        lastSeenAt: new Date().toISOString(),
        runtime: input.runtime,
        status: input.status,
      };

      return nodes[index];
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

function memorySettingsStore(profiles: RecordingProfile[]) {
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
    async findRecordingProfile(profileId: string) {
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

function memoryMeterFrameStore(): MeterFrameStore {
  return {
    async history() {
      return [];
    },
    async latest() {
      return undefined;
    },
    async save(frame) {
      return {
        frame,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

function requirePermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_schedule_runner",
        name: "Schedule Runner User",
        roles: ["operator"],
        type: "user",
      },
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function auth(): AuthResult {
  return { user: user() };
}

function user(): CurrentUser {
  return {
    email: "schedule-runner@example.com",
    groups: [],
    id: "user_schedule_runner",
    name: "Schedule Runner User",
    permissions: [
      "recording:download",
      "recording:playback",
      "recording:read",
      "schedule:manage",
    ] satisfies Permission[],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function splitProfile(input: Partial<RecordingProfile> = {}): RecordingProfile {
  return {
    bitrateKbps: 128,
    channelMode: "mono_to_stereo_mix",
    codec: "mp3",
    id: "voice-split",
    maxTrackSeconds: 2_700,
    name: "Voice Split",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: true,
    ...input,
  };
}

function schedule(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    enabled: true,
    folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
    id: "sched_split",
    name: "Council Meeting",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: "node_split",
    recordingProfileId: "voice-split",
    retentionPolicyId: "retention-keep-controller-cache",
    recurrence: {
      endTime: "11:00",
      interval: 1,
      mode: "daily",
      startTime: "09:00",
    },
    room: "Council Chamber",
    tags: ["voice"],
    timezone: "UTC",
    titleTemplate: "{{date}}_{{time}}_{{schedule.name}}",
    uploadPolicyId: "upload-policy-stub",
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...input,
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Split Runner Node",
    audioDefaults: {
      captureBackend: "pipewire",
    },
    hostname: "split-runner-node",
    id: "node_split",
    interfaces: [
      {
        alias: "USB",
        backend: "alsa",
        channelCount: 2,
        channels: [
          { alias: "A", index: 1 },
          { alias: "B", index: 2 },
        ],
        id: "iface_split",
        sampleRates: [48_000],
        systemName: "hw:1,0",
        systemRef: "usb-split",
      },
      {
        alias: "JACK Council",
        backend: "jack",
        channelCount: 2,
        channels: [
          { alias: "Left", index: 1 },
          { alias: "Right", index: 2 },
        ],
        id: "iface_jack_split",
        sampleRates: [48_000],
        systemName: "jack:council",
        systemRef: "jack:council",
      },
    ],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-18T08:59:00.000Z",
    location: {
      room: "Council Chamber",
      site: "Main",
    },
    status: "online",
    tags: ["voice"],
    ...input,
  };
}

function wavFile(samples: number[]) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48_000, 24);
  buffer.writeUInt32LE(96_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));

  return buffer;
}
