import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, MeterFrame, RecorderNode, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput, NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-job-scope-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(routeRoot, "retention-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createRecordingJob, recordingJob } = await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("agent job mutations validate recording ownership", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const routeNode = node();
  const hiddenRecording = recording({
    id: `rec_agent_job_hidden_${randomUUID()}`,
    nodeId: "node_agent_other",
    status: "queued",
  });
  const recordingStore = memoryRecordingStore([hiddenRecording]);
  const job = await createRecordingJob({ ...hiddenRecording, nodeId: routeNode.id });

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore([routeNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const claimNext = await app.request(`/api/v1/nodes/${routeNode.id}/recording-jobs/claim-next`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const failed = await app.request(`/api/v1/recording-jobs/${job.id}/failed`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const storedRecording = await recordingStore.find(hiddenRecording.id);
  const storedJob = await recordingJob(job.id);
  const failedAudits = await auditStore.list({ outcome: "failed" });

  assert.equal(claimNext.status, 403);
  assert.equal(failed.status, 403);
  assert.equal(storedRecording?.status, "queued");
  assert.equal(storedJob?.status, "queued");
  assert.deepEqual(
    failedAudits.map((event) => [event.action, event.reason, event.target.id]).sort(),
    [
      ["recording_jobs.claim_next.failed", "node_scope_denied", hiddenRecording.id],
      ["recording_jobs.failed.failed", "node_scope_denied", hiddenRecording.id],
    ].sort(),
  );
});

test("agent cache attach validates recording job ownership", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const routeNode = node();
  const visibleRecording = recording({
    id: `rec_agent_cache_job_${randomUUID()}`,
    nodeId: routeNode.id,
    status: "queued",
  });
  const recordingStore = memoryRecordingStore([visibleRecording]);
  const hiddenJob = await createRecordingJob({ ...visibleRecording, nodeId: "node_agent_other" });

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore([routeNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const response = await app.request(`/api/v1/recordings/${visibleRecording.id}/cache-file`, {
    body: new Uint8Array([82, 73, 70, 70]),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "audio/wav",
      "x-rakkr-recording-job-id": hiddenJob.id,
    },
    method: "PUT",
  });
  const storedRecording = await recordingStore.find(visibleRecording.id);
  const storedJob = await recordingJob(hiddenJob.id);
  const [failedAudit] = await auditStore.list({ action: "recordings.cache_file.attach.failed" });

  assert.equal(response.status, 403);
  assert.equal(storedRecording?.cached, false);
  assert.equal(storedRecording?.status, "queued");
  assert.equal(storedRecording?.cachePath, undefined);
  assert.equal(storedJob?.status, "queued");
  assert.equal(failedAudit?.reason, "node_scope_denied");
  assert.equal(failedAudit?.target.id, hiddenJob.id);
  assert.equal(failedAudit?.target.type, "recording_job");
});

function memoryNodeStore(nodes: RecorderNode[]): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? { credentialId: "cred_agent_job_scope", nodeId: nodes[0]!.id, tokenPrefix: "node-token" }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
    },
    async heartbeat(nodeId: string, input: NodeHeartbeatInput) {
      return nodes.find((candidate) => candidate.id === nodeId)
        ? { ...nodes[0]!, runtime: input.runtime, status: input.status }
        : undefined;
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
  const frames: MeterFrame[] = [];

  return {
    async history() {
      return frames;
    },
    async latest() {
      return frames[0];
    },
    async save(frame) {
      frames.unshift(frame);

      return { frame, receivedAt: new Date().toISOString() };
    },
  };
}

function memoryRecordingStore(recordings: RecordingSummary[]): RecordingStore {
  return {
    async create(recordingSummary) {
      recordings.unshift(recordingSummary);
    },
    async delete(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recordingSummary) {
      const index = recordings.findIndex((candidate) => candidate.id === recordingSummary.id);

      if (index >= 0) {
        recordings[index] = recordingSummary;
      }
    },
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "node_agent_job_scope",
        name: "Node Agent",
        roles: [],
        type: "node",
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
    alias: "Agent Job Scope Node",
    hostname: "agent-job-scope-node",
    id: `node_agent_job_scope_${randomUUID()}`,
    interfaces: [],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Test Room", site: "Test Site" },
    status: "online",
    tags: [],
  };
}

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "agent",
    healthStatus: "unknown",
    id: "rec_agent_job_scope",
    name: "Agent Job Scope Recording",
    nodeId: "node_agent_job_scope",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "queued",
    tags: ["agent"],
    ...input,
  };
}
