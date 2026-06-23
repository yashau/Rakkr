import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, MeterFrame, RecorderNode } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeStore } from "../src/node-store.js";

const { registerAgentMeterFrameRoute } = await import("../src/agent-meter-frame-route.js");
const { createAuditStore } = await import("../src/audit-store.js");

test("agent meter-frame ingest audits successes and rejected frames", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const meterFrameStore = memoryMeterFrameStore();

  registerAgentMeterFrameRoute({
    app,
    meterFrameStore,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
  });

  const validFrame = meterFrame();
  const success = await app.request(`/api/v1/nodes/${node().id}/meter-frame`, {
    body: JSON.stringify(validFrame),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const invalid = await app.request(`/api/v1/nodes/${node().id}/meter-frame`, {
    body: JSON.stringify({ ...validFrame, interfaceId: "" }),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const mismatch = await app.request(`/api/v1/nodes/${node().id}/meter-frame`, {
    body: JSON.stringify({ ...validFrame, nodeId: "node_agent_other" }),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const stored = await meterFrameStore.latest(node().id);
  const [successEvent] = await auditStore.list({
    action: "nodes.meter_frame.ingest.succeeded",
  });
  const failures = await auditStore.list({
    action: "nodes.meter_frame.ingest.failed",
  });

  assert.equal(success.status, 202);
  assert.equal(invalid.status, 400);
  assert.equal(mismatch.status, 403);
  assert.equal(stored?.nodeId, node().id);
  assert.equal(successEvent?.actor.type, "node");
  assert.equal(successEvent?.permission, "node:control");
  assert.equal(successEvent?.target.id, node().id);
  assert.equal(successEvent?.details.capturedAt, validFrame.capturedAt);
  assert.equal(successEvent?.details.interfaceId, validFrame.interfaceId);
  assert.equal(successEvent?.details.levelCount, 2);
  assert.equal(successEvent?.details.clippingCount, 1);
  assert.equal(successEvent?.details.qualityLevelCount, 1);
  assert.match(String(successEvent?.details.receivedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(failures.map((event) => [event.reason, event.target.id]).sort(), [
    ["invalid_request", node().id],
    ["node_scope_denied", "node_agent_other"],
  ]);
});

test("agent meter-frame ingest audits missing and invalid credentials", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");

  registerAgentMeterFrameRoute({
    app,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
  });

  const missing = await app.request(`/api/v1/nodes/${node().id}/meter-frame`, {
    body: JSON.stringify(meterFrame()),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const invalid = await app.request(`/api/v1/nodes/${node().id}/meter-frame`, {
    body: JSON.stringify(meterFrame()),
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const failures = await auditStore.list({
    action: "nodes.meter_frame.ingest.failed",
  });

  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.deepEqual(failures.map((event) => [event.outcome, event.reason, event.target.id]).sort(), [
    ["denied", "invalid_node_token", node().id],
    ["denied", "missing_node_token", node().id],
  ]);
});

function memoryNodeStore(): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? {
            credentialId: "cred_agent_meter",
            nodeId: "node_agent_test",
            tokenPrefix: "node-token",
          }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find() {
      throw new Error("not implemented");
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      throw new Error("not implemented");
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

function memoryMeterFrameStore(): MeterFrameStore {
  const frames: MeterFrame[] = [];

  return {
    async history(nodeId, limit = frames.length) {
      return frames.filter((frame) => frame.nodeId === nodeId).slice(0, limit);
    },
    async latest(nodeId) {
      return frames.find((frame) => frame.nodeId === nodeId);
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
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: "audit_agent_meter_frame_test",
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

function meterFrame(input: Partial<MeterFrame> = {}): MeterFrame {
  return {
    capturedAt: "2026-06-18T12:00:00.000Z",
    interfaceId: "iface_agent_meter",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Ch 1",
        peakDbfs: -12,
        quality: {
          crestFactorDb: 13,
          estimatedSnrDb: 24,
          noiseScore: 0.18,
          speechLike: true,
          speechScore: 0.82,
          zeroCrossingRate: 0.11,
        },
        rmsDbfs: -24,
      },
      {
        channelIndex: 2,
        clipping: true,
        label: "Ch 2",
        peakDbfs: -0.2,
        rmsDbfs: -8,
      },
    ],
    nodeId: "node_agent_test",
    ...input,
  };
}
