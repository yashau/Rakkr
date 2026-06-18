import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";

const runnerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-schedule-runner-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(runnerRoot, "jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { listRecordingJobs } = await import("../src/recording-jobs.js");
const { runDueSchedules } = await import("../src/schedule-runner.js");

test.after(async () => {
  await rm(runnerRoot, { force: true, recursive: true });
});

test("due schedule creates ordered track jobs when profile has max track length", async () => {
  const recordingStore = memoryRecordingStore();
  const scheduleStore = memoryScheduleStore([schedule()]);
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
        durationSeconds: command.durationSeconds,
        outputCodec: command.outputCodec,
        trackIndex: command.trackIndex,
        trackTotal: command.trackTotal,
      })),
    [
      { durationSeconds: 2_700, outputCodec: "mp3", trackIndex: 1, trackTotal: 3 },
      { durationSeconds: 2_700, outputCodec: "mp3", trackIndex: 2, trackTotal: 3 },
      { durationSeconds: 1_800, outputCodec: "mp3", trackIndex: 3, trackTotal: 3 },
    ],
  );
  assert.equal(new Set(recordings.map((recording) => recording.trackGroupId)).size, 1);
});

function memoryRecordingStore(recordings: RecordingSummary[] = []) {
  return {
    async create(recording: RecordingSummary) {
      recordings.unshift(recording);
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
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId: string) {
      return nodes.find((node) => node.id === nodeId);
    },
    async list() {
      return nodes;
    },
    async rotateCredential() {
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

function splitProfile(): RecordingProfile {
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
  };
}

function schedule(): ScheduleSummary {
  return {
    enabled: true,
    folderTemplate: "Meetings/{{date}}/{{schedule.name}}",
    id: "sched_split",
    name: "Council Meeting",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: "node_split",
    recordingProfileId: "voice-split",
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
  };
}

function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Split Runner Node",
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
  };
}
