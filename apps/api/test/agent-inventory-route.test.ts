import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, RecorderNode } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { NodeInterfaceInput, NodeStore } from "../src/node-store.js";

const { registerAgentInventoryRoute } = await import("../src/agent-inventory-route.js");
const { reconcileSeedInterfaces } = await import("../src/node-inventory-reconcile.js");
const { createAuditStore } = await import("../src/audit-store.js");

test("agent inventory reconcile audits real changes and is a no-op when unchanged", async () => {
  const { app, auditStore, store } = setup();

  const initial = await app.request(`/api/v1/nodes/${NODE_ID}/inventory`, {
    body: JSON.stringify({ interfaces: [agentInterface()] }),
    headers: authHeaders(),
    method: "POST",
  });
  const initialBody = (await initial.json()) as {
    data: { changed: boolean; node: RecorderNode };
  };
  // Repeat the same report — nothing changed, so it must be an idempotent no-op.
  const repeat = await app.request(`/api/v1/nodes/${NODE_ID}/inventory`, {
    body: JSON.stringify({ interfaces: [agentInterface()] }),
    headers: authHeaders(),
    method: "POST",
  });
  const repeatBody = (await repeat.json()) as { data: { changed: boolean } };
  const reconciled = await auditStore.list({ action: "nodes.inventory.reconciled" });

  assert.equal(initial.status, 202);
  assert.equal(initialBody.data.changed, true);
  assert.equal(initialBody.data.node.interfaces.length, 1);
  assert.equal(repeat.status, 202);
  assert.equal(repeatBody.data.changed, false);
  // Exactly one auditable change across both requests.
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].actor.type, "node");
  assert.equal(reconciled[0].permission, "node:control");
  assert.equal(reconciled[0].target.id, NODE_ID);
  assert.equal(reconciled[0].details.addedCount, 1);

  void store;
});

test("agent inventory reconcile rejects bad credentials and cross-node scope", async () => {
  const { app, auditStore } = setup();

  const missing = await app.request(`/api/v1/nodes/${NODE_ID}/inventory`, {
    body: JSON.stringify({ interfaces: [] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const invalidToken = await app.request(`/api/v1/nodes/${NODE_ID}/inventory`, {
    body: JSON.stringify({ interfaces: [] }),
    headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
    method: "POST",
  });
  const crossNode = await app.request(`/api/v1/nodes/node_other/inventory`, {
    body: JSON.stringify({ interfaces: [] }),
    headers: authHeaders(),
    method: "POST",
  });
  const badBody = await app.request(`/api/v1/nodes/${NODE_ID}/inventory`, {
    body: JSON.stringify({ interfaces: [{ systemName: "" }] }),
    headers: authHeaders(),
    method: "POST",
  });
  const failures = await auditStore.list({ action: "nodes.inventory.reconciled.failed" });

  assert.equal(missing.status, 401);
  assert.equal(invalidToken.status, 401);
  assert.equal(crossNode.status, 403);
  assert.equal(badBody.status, 400);
  assert.deepEqual(failures.map((event) => [event.outcome, event.reason]).sort(), [
    ["denied", "invalid_node_token"],
    ["denied", "missing_node_token"],
    ["failed", "invalid_request"],
    ["failed", "node_scope_denied"],
  ]);
});

const NODE_ID = "node_inventory_test";

function setup() {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const store = statefulNodeStore();

  registerAgentInventoryRoute({
    app,
    nodeStore: store,
    recordAuditEvent: recordAuditEvent(auditStore),
  });

  return { app, auditStore, store };
}

function authHeaders() {
  return { authorization: "Bearer node-token", "content-type": "application/json" };
}

// Stateful in-memory store that drives the real reconcile logic so the route
// test exercises end-to-end behaviour (auth + reconcile + idempotency).
function statefulNodeStore(): NodeStore {
  let current = node();

  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? { credentialId: "cred_inventory", nodeId: NODE_ID, tokenPrefix: "node-token" }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find() {
      return current;
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return [current];
    },
    async reconcileInterfaces(nodeId, interfaces: NodeInterfaceInput[]) {
      if (nodeId !== current.id) {
        return undefined;
      }

      const { interfaces: nextInterfaces, summary } = reconcileSeedInterfaces(
        current.interfaces,
        interfaces,
      );

      current = { ...current, interfaces: nextInterfaces };

      return { node: current, summary };
    },
    async rotateCredential() {
      throw new Error("not implemented");
    },
    async seed() {},
    async update() {
      throw new Error("not implemented");
    },
    async updateInterface() {
      throw new Error("not implemented");
    },
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  let sequence = 0;

  return async (_c, input) => {
    sequence += 1;
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? { id: "anonymous", name: "Anonymous", roles: [], type: "user" },
      actorContext: {},
      after: input.after,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_inventory_${sequence}`,
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
    alias: "Inventory Node",
    hostname: "inventory-node",
    id: NODE_ID,
    interfaces: [],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Test Room", site: "Test Site" },
    status: "online",
    tags: [],
  };
}

function agentInterface(input: Partial<NodeInterfaceInput> = {}): NodeInterfaceInput {
  return {
    alias: "X-USB USB Audio",
    backend: "alsa",
    channelCount: 2,
    channels: [],
    sampleRates: [48000],
    systemName: "X-USB USB Audio",
    systemRef: "hw:CARD=X32,DEV=0",
    ...input,
  };
}
