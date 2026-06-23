import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, MeterFrame, RecorderNode, RecordingSummary } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput, NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { SettingsStore } from "../src/settings-store.js";

process.env.DATABASE_URL = "";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");

test("agent heartbeat audits changed and unchanged successes", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const routeNode = node();
  const nodeStore = memoryNodeStore([routeNode]);
  const heartbeat = {
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
  };

  registerAgentRoutes({
    app,
    healthEventStore: createHealthEventStore("", []),
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    settingsStore: {} as SettingsStore,
  });

  const changed = await postHeartbeat(app, routeNode.id, heartbeat);
  const unchanged = await postHeartbeat(app, routeNode.id, heartbeat);
  const changedBody = (await changed.json()) as { data: RecorderNode };
  const audits = await auditStore.list({ action: "nodes.heartbeat.succeeded" });

  assert.equal(changed.status, 202);
  assert.equal(unchanged.status, 202);
  assert.equal(changedBody.data.agentVersion, "0.2.0");
  assert.equal(changedBody.data.hostname, "agent-route-node-live");
  assert.deepEqual(changedBody.data.ipAddresses, ["10.9.0.8"]);
  assert.equal(changedBody.data.runtime?.kernelRelease, "6.1.0-test");
  assert.equal(changedBody.data.runtime?.uptimeSeconds, 12345);
  assert.equal(audits.length, 2);
  const changedAudit = audits.find((event) => event.details.changed);
  const unchangedAudit = audits.find((event) => event.details.changed === false);

  assert.equal(changedAudit?.before?.hostname, "agent-route-node");
  assert.equal(changedAudit?.after?.hostname, "agent-route-node-live");
  assert.equal(unchangedAudit?.before, undefined);
  assert.equal(unchangedAudit?.after, undefined);
  assert.ok(audits.every((event) => event.actor.type === "node"));
  assert.ok(audits.every((event) => event.permission === "node:control"));
});

function postHeartbeat(app: Hono<AppBindings>, nodeId: string, heartbeat: NodeHeartbeatInput) {
  return app.request(`/api/v1/nodes/${nodeId}/heartbeat`, {
    body: JSON.stringify(heartbeat),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function memoryNodeStore(nodes: RecorderNode[]): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? { credentialId: "cred_agent_heartbeat", nodeId: nodes[0]!.id, tokenPrefix: "node-token" }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
    },
    async heartbeat(nodeId, input) {
      const index = nodes.findIndex((candidate) => candidate.id === nodeId);

      if (index < 0) {
        return undefined;
      }

      nodes[index] = {
        ...nodes[index]!,
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

function memoryRecordingStore(): RecordingStore {
  const recordings: RecordingSummary[] = [];

  return {
    async create(recording) {
      recordings.unshift(recording);
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
        id: "node_agent_heartbeat",
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
    alias: "Agent Heartbeat Node",
    hostname: "agent-route-node",
    id: `node_agent_heartbeat_${randomUUID()}`,
    interfaces: [],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Test Room", site: "Test Site" },
    status: "recording",
    tags: [],
  };
}
