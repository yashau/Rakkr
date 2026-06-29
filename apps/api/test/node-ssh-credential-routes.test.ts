import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecorderNode } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { NodeStore } from "../src/node-store.js";
import type {
  NodeSshCredentialMetadata,
  NodeSshCredentialStore,
} from "../src/node-ssh-credential-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { createListenSessionStore } = await import("../src/listen-session-store.js");
const { registerNodeRoutes } = await import("../src/node-routes.js");

const NODE_ID = "node_ssh_test";
const RUNNER_TOKEN = "runner-secret-token";

test("operator rotate + read expose only the public SSH material, never the private key", async () => {
  const auditStore = createAuditStore("");
  const sshStore = memorySshStore();
  const app = buildApp({ auditStore, sshStore });

  const rotate = await app.request(`/api/v1/nodes/${NODE_ID}/ssh-credential/rotate`, {
    body: JSON.stringify({ username: "rakkr" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const rotateBody = (await rotate.json()) as { data: Record<string, unknown> };
  const read = await app.request(`/api/v1/nodes/${NODE_ID}/ssh-credential`);
  const readBody = (await read.json()) as { data: NodeSshCredentialMetadata };
  const rotateEvent = (
    await auditStore.list({ action: "nodes.ssh_credential.rotate.succeeded" })
  )[0];

  assert.equal(rotate.status, 201);
  assert.match(String(rotateBody.data.publicKey), /^ssh-rsa /);
  assert.equal(rotateBody.data.privateKey, undefined);
  assert.equal(read.status, 200);
  assert.equal(readBody.data.fingerprint, rotateBody.data.fingerprint);
  assert.equal(rotateEvent?.permission, "node:manage");
  assert.equal(rotateEvent?.details.fingerprint, rotateBody.data.fingerprint);
  // The audited details must never carry private key material.
  assert.equal(JSON.stringify(rotateEvent).includes("PRIVATE"), false);
});

test("runner material fetch enforces the runner token and can mint a controller token", async (t) => {
  const auditStore = createAuditStore("");
  const sshStore = memorySshStore();
  const nodeStore = memoryNodeStore([node()]);
  const app = buildApp({ auditStore, nodeStore, sshStore });

  await sshStore.rotate(NODE_ID);

  const previousToken = process.env.RAKKR_RUNNER_TOKEN;
  process.env.RAKKR_RUNNER_TOKEN = RUNNER_TOKEN;
  t.after(() => {
    if (previousToken === undefined) {
      delete process.env.RAKKR_RUNNER_TOKEN;
    } else {
      process.env.RAKKR_RUNNER_TOKEN = previousToken;
    }
  });

  const noAuth = await app.request(`/api/v1/nodes/${NODE_ID}/ssh-credential/material`);
  const wrong = await app.request(`/api/v1/nodes/${NODE_ID}/ssh-credential/material`, {
    headers: { authorization: "Bearer nope" },
  });
  const ok = await app.request(`/api/v1/nodes/${NODE_ID}/ssh-credential/material?mintToken=1`, {
    headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
  });
  const okBody = (await ok.json()) as { data: Record<string, unknown> };
  const fetchEvent = (await auditStore.list({ action: "nodes.ssh_credential.fetch.succeeded" }))[0];
  const denied = await auditStore.list({ action: "nodes.ssh_credential.fetch.failed" });

  assert.equal(noAuth.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(ok.status, 200);
  assert.match(String(okBody.data.privateKey), /BEGIN PRIVATE KEY/);
  assert.equal(okBody.data.username, "rakkr");
  // mintToken=1 provisions a fresh controller token for the agent.
  assert.equal(okBody.data.controllerToken, "minted-token");
  assert.equal(fetchEvent?.actor.type, "system");
  assert.equal(fetchEvent?.details.provisionedToken, true);
  assert.equal(JSON.stringify(fetchEvent).includes("BEGIN PRIVATE KEY"), false);
  // Both the missing-header and wrong-token attempts are denied as invalid tokens.
  assert.deepEqual(denied.map((event) => event.reason).sort(), [
    "invalid_runner_token",
    "invalid_runner_token",
  ]);
});

function buildApp({
  auditStore,
  nodeStore = memoryNodeStore([node()]),
  sshStore,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  nodeStore?: NodeStore;
  sshStore: NodeSshCredentialStore;
}) {
  const app = new Hono<AppBindings>();
  const currentUser = user(["node:manage", "node:read"]);

  registerNodeRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    hasResourceScope: async () => true,
    listenMonitorStore: createListenMonitorStore(),
    listenSessionStore: createListenSessionStore(),
    meterFrameStore: {
      history: async () => [],
      latest: async () => undefined,
      save: async (f) => ({ frame: f, receivedAt: "" }),
    },
    nodeStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: permissiveRequirePermission(),
    scopedNodes: async () => [node()],
    sshCredentialStore: sshStore,
  });

  return app;
}

function memorySshStore(): NodeSshCredentialStore {
  const byNode = new Map<string, NodeSshCredentialMetadata & { privateKey: string }>();

  return {
    async findActiveMaterial(nodeId) {
      return byNode.get(nodeId);
    },
    async findActiveMetadata(nodeId) {
      const credential = byNode.get(nodeId);

      if (!credential) {
        return undefined;
      }

      const { privateKey, ...metadata } = credential;
      void privateKey;
      return metadata;
    },
    async rotate(nodeId, options) {
      const credential = {
        createdAt: "2026-06-30T00:00:00.000Z",
        fingerprint: `SHA256:${randomUUID().replace(/-/g, "")}`,
        id: randomUUID(),
        nodeId,
        privateKey: "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n",
        publicKey: "ssh-rsa AAAAB3NzaC1yc2EMOCK rakkr",
        username: options?.username ?? "rakkr",
      };

      byNode.set(nodeId, credential);
      const { privateKey, ...metadata } = credential;
      void privateKey;
      return metadata;
    },
  };
}

function memoryNodeStore(nodes: RecorderNode[]): NodeStore {
  return {
    async authenticateCredential() {
      return undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
    },
    async heartbeat() {
      throw new Error("not implemented");
    },
    async list() {
      return nodes;
    },
    async reconcileInterfaces() {
      return undefined;
    },
    async rotateCredential(nodeId) {
      return {
        credential: {
          createdAt: "2026-06-30T00:00:00.000Z",
          id: "cred_minted",
          nodeId,
          token: "minted-token",
          tokenPrefix: "rakkr_node_minted",
        },
        node: nodes.find((candidate) => candidate.id === nodeId)!,
      };
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

function permissiveRequirePermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: "user_ssh",
        name: "SSH Operator",
        roles: ["operator"],
        type: "user",
      },
      actorContext: {},
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

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "ssh@example.com",
    groups: [],
    id: "user_ssh",
    name: "SSH Operator",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "SSH Node",
    hostname: "ssh-node",
    id: NODE_ID,
    interfaces: [],
    ipAddresses: ["10.0.0.60"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Room", site: "Site" },
    status: "online",
    tags: [],
    ...input,
  };
}
