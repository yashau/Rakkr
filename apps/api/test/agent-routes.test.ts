import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, RecorderNode, RecordingProfile, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput, NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const agentRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(agentRoot, "jobs.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createRecordingJob } = await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(agentRoot, { force: true, recursive: true });
});

test("agent failed job marks recording metadata failed", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const recordingStore = memoryRecordingStore([recording()]);
  const job = await createRecordingJob((await recordingStore.list())[0]!);

  assert.equal(job.command.outputBitrateKbps, 128);
  assert.equal(job.command.outputCodec, "mp3");
  assert.equal(job.command.outputFileName, "rec_agent_failure.mp3");
  assert.equal(job.command.outputVbr, true);

  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/recording-jobs/${job.id}/failed`, {
    headers: {
      authorization: "Bearer node-token",
      "x-rakkr-reason": "capture_output_stalled",
    },
    method: "POST",
  });
  const updated = await recordingStore.find("rec_agent_failure");
  const [event] = await auditStore.list({ action: "recording_jobs.failed.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(updated?.status, "failed");
  assert.equal(event?.details.recordingStatus, "failed");
  assert.equal(event?.details.reason, "capture_output_stalled");
});

test("agent heartbeat updates node runtime details and audits inventory changes", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const nodeStore = memoryNodeStore();

  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/nodes/${node().id}/heartbeat`, {
    body: JSON.stringify({
      agentVersion: "0.2.0",
      hostname: "agent-route-node-live",
      ipAddresses: ["10.9.0.8"],
      runtime: {
        architecture: "x86_64",
        audioBackends: ["alsa"],
        kernelRelease: "6.1.0-test",
        osName: "Debian GNU/Linux 12",
        uptimeSeconds: 12345,
      },
      status: "online",
    }),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const body = (await response.json()) as { data: RecorderNode };
  const [event] = await auditStore.list({ action: "nodes.heartbeat.succeeded" });

  assert.equal(response.status, 202);
  assert.equal(body.data.agentVersion, "0.2.0");
  assert.equal(body.data.hostname, "agent-route-node-live");
  assert.deepEqual(body.data.ipAddresses, ["10.9.0.8"]);
  assert.equal(body.data.runtime?.kernelRelease, "6.1.0-test");
  assert.equal(body.data.runtime?.uptimeSeconds, 12345);
  assert.equal(event?.actor.type, "node");
  assert.equal(event?.permission, "node:control");
  assert.equal(event?.after?.hostname, "agent-route-node-live");
});

test("recording job honors custom output profile", async () => {
  const job = await createRecordingJob(
    {
      ...recording(),
      id: "rec_custom_profile",
    },
    {
      profile: flacProfile(),
    },
  );

  assert.equal(job.command.outputBitrateKbps, 256);
  assert.equal(job.command.outputCodec, "flac");
  assert.equal(job.command.outputFileName, "rec_custom_profile.flac");
  assert.equal(job.command.outputVbr, false);
});

function memoryNodeStore(nodes: RecorderNode[] = [node()]): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? {
            credentialId: "cred_agent_test",
            nodeId: "node_agent_test",
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

function memoryMeterFrameStore(): MeterFrameStore {
  return {
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

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
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

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
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

function node(): RecorderNode {
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

function recording(): RecordingSummary {
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

function flacProfile(): RecordingProfile {
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
