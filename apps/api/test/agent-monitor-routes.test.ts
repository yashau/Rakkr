import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { NodeStore } from "../src/node-store.js";

const { registerAgentMonitorRoutes } = await import("../src/agent-monitor-routes.js");
const { createAuditStore } = await import("../src/audit-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");

test("agent monitor chunk route stores latest node audio chunk", async () => {
  const auditStore = createAuditStore("");
  const listenMonitorStore = createListenMonitorStore();
  const app = new Hono<AppBindings>();
  const audio = wavChunk();

  registerAgentMonitorRoutes({
    app,
    listenMonitorStore,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
  });

  const response = await app.request("/api/v1/nodes/node_agent_test/listen/chunk", {
    body: audio,
    headers: {
      authorization: "Bearer node-token",
      "content-type": "audio/wav",
      "x-rakkr-captured-at": "2026-06-20T08:30:00.000Z",
      "x-rakkr-duration-ms": "1000",
    },
    method: "POST",
  });
  const body = (await response.json()) as { data: { source: string } };
  const stored = await listenMonitorStore.latest("node_agent_test");
  const [event] = await auditStore.list({
    action: "nodes.listen_monitor.chunk.ingest.succeeded",
  });

  assert.equal(response.status, 202);
  assert.equal(body.data.source, "agent_audio_chunk");
  assert.equal(stored?.capturedAt, "2026-06-20T08:30:00.000Z");
  assert.equal(stored?.durationMs, 1000);
  assert.deepEqual(Buffer.from(stored?.audio ?? []), audio);
  assert.equal(event?.actor.type, "node");
  assert.equal(event?.outcome, "succeeded");
  assert.equal(event?.permission, "node:control");
  assert.equal(event?.target.id, "node_agent_test");
  assert.equal(event?.target.type, "node");
  assert.deepEqual(event?.details, {
    capturedAt: "2026-06-20T08:30:00.000Z",
    durationMs: 1000,
    receivedAt: stored?.receivedAt,
    rendition: "raw",
    sizeBytes: audio.byteLength,
    source: "agent_audio_chunk",
  });
});

test("agent monitor chunk route audits missing node credentials", async () => {
  const auditStore = createAuditStore("");
  const app = new Hono<AppBindings>();

  registerAgentMonitorRoutes({
    app,
    listenMonitorStore: createListenMonitorStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
  });

  const response = await app.request("/api/v1/nodes/node_agent_test/listen/chunk", {
    body: wavChunk(),
    headers: {
      "content-type": "audio/wav",
      "x-rakkr-captured-at": "2026-06-20T08:30:00.000Z",
      "x-rakkr-duration-ms": "1000",
    },
    method: "POST",
  });
  const [event] = await auditStore.list({
    action: "nodes.listen_monitor.chunk.ingest.failed",
  });

  assert.equal(response.status, 401);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.permission, "node:control");
  assert.equal(event?.reason, "missing_node_token");
});

test("agent monitor chunk route blocks credentials from writing other node chunks", async () => {
  const auditStore = createAuditStore("");
  const listenMonitorStore = createListenMonitorStore();
  const app = new Hono<AppBindings>();

  registerAgentMonitorRoutes({
    app,
    listenMonitorStore,
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
  });

  const response = await app.request("/api/v1/nodes/node_agent_other/listen/chunk", {
    body: wavChunk(),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "audio/wav",
      "x-rakkr-captured-at": "2026-06-20T08:30:00.000Z",
      "x-rakkr-duration-ms": "1000",
    },
    method: "POST",
  });
  const [event] = await auditStore.list({
    action: "nodes.listen_monitor.chunk.ingest.failed",
  });
  const stored = await listenMonitorStore.latest("node_agent_other");

  assert.equal(response.status, 403);
  assert.equal(stored, undefined);
  assert.equal(event?.actor.type, "node");
  assert.equal(event?.outcome, "failed");
  assert.equal(event?.permission, "node:control");
  assert.equal(event?.reason, "node_scope_denied");
  assert.equal(event?.target.id, "node_agent_other");
  assert.equal(event?.target.type, "node");
});

function memoryNodeStore(): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? {
            nodeId: "node_agent_test",
            tokenId: "node_token_agent_test",
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
      id: "audit_agent_monitor_test",
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function wavChunk() {
  const bytes = Buffer.alloc(48);

  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(100, 44);
  bytes.writeInt16LE(-100, 46);

  return bytes;
}
