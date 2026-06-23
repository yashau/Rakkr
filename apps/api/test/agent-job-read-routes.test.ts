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

const routeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-agent-job-read-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_JOB_STORE_PATH = path.join(routeRoot, "jobs.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(routeRoot, "retention-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");
const { createRecordingJob } = await import("../src/recording-jobs.js");

test.after(async () => {
  await rm(routeRoot, { force: true, recursive: true });
});

test("agent recording-job polling and reads audit successes", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const routeNode = node();
  const routeRecording = recording({ nodeId: routeNode.id });
  const recordingStore = memoryRecordingStore([routeRecording]);
  const job = await createRecordingJob(routeRecording);

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore([routeNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore,
    settingsStore: {} as SettingsStore,
  });

  const queuedNext = await app.request(`/api/v1/nodes/${routeNode.id}/recording-jobs/next`, {
    headers: { authorization: "Bearer node-token" },
  });
  const claimed = await app.request(`/api/v1/recording-jobs/${job.id}/claim`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const emptyNext = await app.request(`/api/v1/nodes/${routeNode.id}/recording-jobs/next`, {
    headers: { authorization: "Bearer node-token" },
  });
  const read = await app.request(`/api/v1/recording-jobs/${job.id}`, {
    headers: { authorization: "Bearer node-token" },
  });
  const nextAudits = await auditStore.list({ action: "recording_jobs.next.succeeded" });
  const [readAudit] = await auditStore.list({ action: "recording_jobs.read_one.succeeded" });

  assert.equal(queuedNext.status, 200);
  assert.equal(claimed.status, 200);
  assert.equal(emptyNext.status, 204);
  assert.equal(read.status, 200);
  assert.deepEqual(
    nextAudits
      .map((event) => [
        event.target.id,
        event.details.queued,
        event.details.recordingJobId,
        event.correlationIds?.recordingJobId,
      ])
      .sort(),
    [
      [routeNode.id, false, undefined, undefined],
      [routeNode.id, true, job.id, job.id],
    ],
  );
  assert.equal(readAudit?.actor.type, "node");
  assert.equal(readAudit?.permission, "recording:control");
  assert.equal(readAudit?.target.id, job.id);
  assert.equal(readAudit?.details.nodeId, routeNode.id);
  assert.equal(readAudit?.details.recordingId, routeRecording.id);
  assert.equal(readAudit?.details.status, "running");
  assert.deepEqual(readAudit?.correlationIds, {
    recordingId: routeRecording.id,
    recordingJobId: job.id,
  });
});

test("agent claim-next empty result audits success", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const routeNode = node();

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore([routeNode]),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore([]),
    settingsStore: {} as SettingsStore,
  });

  const emptyClaim = await app.request(`/api/v1/nodes/${routeNode.id}/recording-jobs/claim-next`, {
    headers: { authorization: "Bearer node-token" },
    method: "POST",
  });
  const [audit] = await auditStore.list({ action: "recording_jobs.claim_next.succeeded" });

  assert.equal(emptyClaim.status, 204);
  assert.equal(audit?.actor.type, "node");
  assert.equal(audit?.permission, "recording:control");
  assert.equal(audit?.target.id, routeNode.id);
  assert.equal(audit?.target.type, "node");
  assert.equal(audit?.details.claimed, false);
  assert.equal(audit?.correlationIds, undefined);
});

function memoryNodeStore(nodes: RecorderNode[]): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? { credentialId: "cred_agent_job_read", nodeId: nodes[0]!.id, tokenPrefix: "node-token" }
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
        id: "node_agent_job_read",
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
    alias: "Agent Job Read Node",
    hostname: "agent-job-read-node",
    id: `node_agent_job_read_${randomUUID()}`,
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
    durationSeconds: 900,
    healthStatus: "unknown",
    id: `rec_agent_job_read_${randomUUID()}`,
    name: "Agent Job Read Recording",
    nodeId: "node_agent_job_read",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "adhoc",
    status: "queued",
    tags: [],
    ...input,
  };
}
