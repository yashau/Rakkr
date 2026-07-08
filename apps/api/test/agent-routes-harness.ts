import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AuditEvent,
  CurrentUser,
  MeterFrame,
  Permission,
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
} from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type { RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput, NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

// Shared harness for the agent route tests. Extracted from agent-routes.test.ts
// to keep each test file under the 1000-LOC guard.
//
// The store modules read their RAKKR_*_STORE_PATH env vars at import time, so
// the env setup below MUST run before the dynamic imports.

const agentRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(agentRoot, "jobs.json");
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(agentRoot, "cache");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(agentRoot, "retention-policies.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(agentRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH = path.join(agentRoot, "upload-queue.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createRecordingJob } = await import("../src/recording-jobs.js");
const { createRetentionPolicy } = await import("../src/retention-policies.js");
const { registerRecordingRoutes } = await import("../src/recording-routes.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");

export {
  createAuditStore,
  createHealthEventStore,
  createRecordingJob,
  createRetentionPolicy,
  createUploadPolicy,
  registerAgentRoutes,
  registerRecordingRoutes,
};

test.after(async () => {
  await rm(agentRoot, { force: true, recursive: true });
});

export function memoryNodeStore(nodes: RecorderNode[] = [node()]): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? {
            credentialId: "cred_agent_test",
            nodeId: nodes[0]?.id ?? "node_agent_test",
            tokenPrefix: "node-token",
          }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
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

export function requirePermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

export function memoryMeterFrameStore(): MeterFrameStore {
  const frames: MeterFrame[] = [];

  return {
    async history(nodeId, limit = frames.length) {
      return frames.filter((frame) => frame.nodeId === nodeId).slice(0, limit);
    },
    async latest() {
      return frames[0];
    },
    async save(frame) {
      frames.unshift(frame);

      return {
        frame,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

export function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
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
    async transition(recording, allowedFrom) {
      const index = recordings.findIndex((candidate) => candidate.id === recording.id);
      const current = recordings[index];

      if (!current || !allowedFrom.includes(current.status)) {
        return undefined;
      }

      recordings[index] = recording;

      return recording;
    },
  };
}

export function recordAuditEvent(
  auditStore: ReturnType<typeof createAuditStore>,
): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "anonymous",
        name: "Anonymous",
        roles: [],
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

export function memorySettingsStore(profiles: RecordingProfile[]): SettingsStore {
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

export function auth(): AuthResult {
  return { user: user() };
}

export function user(): CurrentUser {
  return {
    email: "agent-route@example.com",
    groups: [],
    id: "user_agent_route",
    name: "Agent Route User",
    permissions: [
      "recording:create",
      "recording:download",
      "recording:playback",
      "recording:read",
    ] satisfies Permission[],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

export function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Agent Route Node",
    hostname: "agent-route-node",
    id: "node_agent_test",
    interfaces: [],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Test Room",
      site: "Test Site",
    },
    status: "recording",
    tags: [],
  };
}

export function recording(): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 900,
    folder: "Meetings/2026",
    healthStatus: "unknown",
    id: "rec_agent_failure",
    name: "Agent Failure Test",
    nodeId: "node_agent_test",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "recording",
    tags: ["voice"],
  };
}

export function flacProfile(): RecordingProfile {
  return {
    bitrateKbps: 256,
    channelMode: "stereo",
    codec: "flac",
    id: "voice-flac",
    name: "Voice FLAC",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: false,
  };
}

export function wavFile(samples: number[]) {
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
