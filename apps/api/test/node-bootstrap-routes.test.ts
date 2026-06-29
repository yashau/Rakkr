import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecorderNode } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { NodeBootstrapStore } from "../src/node-bootstrap-store.js";
import type { NodeStore } from "../src/node-store.js";
import type {
  NodeSshCredentialIngestInput,
  NodeSshCredentialStore,
} from "../src/node-ssh-credential-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { createListenSessionStore } = await import("../src/listen-session-store.js");
const { registerNodeRoutes } = await import("../src/node-routes.js");

const NODE_ID = "node_bootstrap_test";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMOCKKEY rakkr-node";
const PRIVATE_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nMOCK\n-----END OPENSSH PRIVATE KEY-----\n";

test("operator issues a single-use bootstrap token without leaking it to the audit log", async () => {
  const auditStore = createAuditStore("");
  const bootstrapStore = memoryBootstrapStore();
  const app = buildApp({ auditStore, bootstrapStore });

  const response = await app.request(`/api/v1/nodes/${NODE_ID}/bootstrap-token`, {
    body: JSON.stringify({ ttlSeconds: 600 }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { data: { token: string; expiresAt: string } };
  const event = (await auditStore.list({ action: "nodes.bootstrap_token.issue.succeeded" }))[0];

  assert.equal(response.status, 201);
  assert.match(body.data.token, /^rakkr_bs_/);
  assert.equal(event?.permission, "node:manage");
  assert.equal(JSON.stringify(event).includes(body.data.token), false);
});

test("bootstrap stores the node key, mints a controller token, and is single-use", async () => {
  const auditStore = createAuditStore("");
  const bootstrapStore = memoryBootstrapStore();
  const sshStore = recordingSshStore();
  const app = buildApp({ auditStore, bootstrapStore, sshStore });

  const issue = await app.request(`/api/v1/nodes/${NODE_ID}/bootstrap-token`, { method: "POST" });
  const { data } = (await issue.json()) as { data: { token: string } };
  const bootstrapBody = JSON.stringify({
    interfaces: [
      {
        alias: "USB",
        backend: "alsa",
        channelCount: 2,
        channels: [],
        sampleRates: [48000],
        systemName: "USB Audio",
        systemRef: "hw:CARD=USB,DEV=0",
      },
    ],
    privateKey: PRIVATE_KEY,
    publicKey: PUBLIC_KEY,
    username: "rakkr",
  });
  const ok = await app.request(`/api/v1/nodes/${NODE_ID}/bootstrap`, {
    body: bootstrapBody,
    headers: { authorization: `Bearer ${data.token}`, "content-type": "application/json" },
    method: "POST",
  });
  const okBody = (await ok.json()) as { data: { controllerToken: string; fingerprint: string } };
  // Replaying the same token must fail: it was consumed.
  const replay = await app.request(`/api/v1/nodes/${NODE_ID}/bootstrap`, {
    body: bootstrapBody,
    headers: { authorization: `Bearer ${data.token}`, "content-type": "application/json" },
    method: "POST",
  });
  const completed = (await auditStore.list({ action: "nodes.bootstrap.completed" }))[0];
  const failed = await auditStore.list({ action: "nodes.bootstrap.failed" });

  assert.equal(ok.status, 201);
  assert.equal(okBody.data.controllerToken, "minted-token");
  assert.equal(sshStore.ingested?.publicKey, PUBLIC_KEY);
  assert.equal(sshStore.ingested?.privateKeyPem, PRIVATE_KEY);
  assert.equal(replay.status, 401);
  assert.equal(completed?.actor.type, "node");
  assert.equal(JSON.stringify(completed).includes("OPENSSH PRIVATE KEY"), false);
  assert.deepEqual(
    failed.map((event) => event.reason),
    ["invalid_bootstrap_token"],
  );
});

test("bootstrap rejects a missing token and a non-OpenSSH public key", async () => {
  const auditStore = createAuditStore("");
  const bootstrapStore = memoryBootstrapStore();
  const app = buildApp({ auditStore, bootstrapStore });

  const issue = await app.request(`/api/v1/nodes/${NODE_ID}/bootstrap-token`, { method: "POST" });
  const { data } = (await issue.json()) as { data: { token: string } };

  const noToken = await app.request(`/api/v1/nodes/${NODE_ID}/bootstrap`, {
    body: JSON.stringify({ privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const badKey = await app.request(`/api/v1/nodes/${NODE_ID}/bootstrap`, {
    body: JSON.stringify({ privateKey: PRIVATE_KEY, publicKey: "not-a-key" }),
    headers: { authorization: `Bearer ${data.token}`, "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(noToken.status, 401);
  assert.equal(badKey.status, 400);
  // A malformed body must not consume the token.
  assert.equal(bootstrapStore.consumedCount, 0);
});

function buildApp({
  auditStore,
  bootstrapStore,
  sshStore = recordingSshStore(),
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  bootstrapStore: NodeBootstrapStore;
  sshStore?: NodeSshCredentialStore;
}) {
  const app = new Hono<AppBindings>();
  const currentUser = user(["node:manage", "node:read"]);

  registerNodeRoutes({
    app,
    bootstrapStore,
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
    nodeStore: memoryNodeStore([node()]),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: permissiveRequirePermission(),
    scopedNodes: async () => [node()],
    sshCredentialStore: sshStore,
  });

  return app;
}

function memoryBootstrapStore(): NodeBootstrapStore & { consumedCount: number } {
  const tokens = new Map<string, { expiresAt: number; nodeId: string }>();

  return {
    consumedCount: 0,
    async consume(nodeId, token) {
      const existing = tokens.get(token);

      if (!existing || existing.nodeId !== nodeId || existing.expiresAt < Date.now()) {
        return false;
      }

      tokens.delete(token);
      this.consumedCount += 1;
      return true;
    },
    async issue(nodeId) {
      const token = `rakkr_bs_${randomUUID().replace(/-/g, "")}`;

      tokens.set(token, { expiresAt: Date.now() + 600_000, nodeId });
      return {
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        nodeId,
        token,
        tokenPrefix: token.slice(0, 24),
      };
    },
  };
}

function recordingSshStore(): NodeSshCredentialStore & { ingested?: NodeSshCredentialIngestInput } {
  return {
    ingested: undefined,
    async findActiveMaterial() {
      return undefined;
    },
    async findActiveMetadata() {
      return undefined;
    },
    async ingest(nodeId, input) {
      this.ingested = input;
      return {
        createdAt: "2026-06-30T00:00:00.000Z",
        fingerprint: "SHA256:bootstrapfingerprint",
        id: "cred_bootstrap",
        nodeId,
        username: input.username ?? "rakkr",
        publicKey: input.publicKey,
      };
    },
    async rotate(nodeId) {
      return {
        createdAt: "2026-06-30T00:00:00.000Z",
        fingerprint: "SHA256:rotated",
        id: "cred_rotated",
        nodeId,
        publicKey: PUBLIC_KEY,
        username: "rakkr",
      };
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
    async reconcileInterfaces(nodeId) {
      return { node: nodes.find((candidate) => candidate.id === nodeId)!, summary: emptySummary() };
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

function emptySummary() {
  return { added: [], absent: [], reactivated: [], unchanged: 0, updated: [] };
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
      actor: input.actor ?? { id: "user_bootstrap", name: "Op", roles: ["operator"], type: "user" },
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
    email: "bootstrap@example.com",
    groups: [],
    id: "user_bootstrap",
    name: "Bootstrap Operator",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Bootstrap Node",
    hostname: "bootstrap-node",
    id: NODE_ID,
    interfaces: [],
    ipAddresses: ["10.0.0.70"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Room", site: "Site" },
    status: "offline",
    tags: [],
    ...input,
  };
}
