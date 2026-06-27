import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, MeterFrame, Permission, RecorderNode } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeLifecycleJob, NodeLifecycleService } from "../src/node-lifecycle.js";
import type { NodeStore } from "../src/node-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { createListenMonitorStore } = await import("../src/listen-monitor-store.js");
const { createListenSessionStore } = await import("../src/listen-session-store.js");
const { registerNodeRoutes } = await import("../src/node-routes.js");

test("node lifecycle route runs allowlisted Ansible action and audits result", async () => {
  const auditStore = createAuditStore("");
  const recorder = node();
  const jobs: NodeLifecycleJob[] = [];
  const service = lifecycleService(jobs);
  const app = nodeLifecycleApp({ auditStore, nodeLifecycleService: service, nodes: [recorder] });

  const response = await app.request(`/api/v1/nodes/${recorder.id}/lifecycle/update_binary`, {
    body: JSON.stringify({ agentVersion: "0.2.0", sshUser: "rakkr" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { data: NodeLifecycleJob };
  const list = await app.request(`/api/v1/nodes/${recorder.id}/lifecycle-jobs`);
  const listBody = (await list.json()) as { data: NodeLifecycleJob[] };
  const [event] = await auditStore.list({ action: "nodes.lifecycle.update_binary.succeeded" });

  assert.equal(response.status, 202);
  assert.equal(body.data.action, "update_binary");
  assert.equal(body.data.nodeId, recorder.id);
  assert.equal(body.data.status, "succeeded");
  assert.equal(body.data.targetHost, "10.0.0.50");
  assert.equal(list.status, 200);
  assert.equal(listBody.data.length, 1);
  assert.equal(event?.outcome, "succeeded");
  assert.equal(event?.permission, "node:manage");
  assert.equal(event?.target.id, recorder.id);
  assert.equal(event?.correlationIds?.nodeLifecycleJobId, body.data.id);
});

test("node lifecycle route only targets scoped visible nodes", async () => {
  const auditStore = createAuditStore("");
  const hidden = node({ id: "node_hidden_lifecycle" });
  const app = nodeLifecycleApp({
    auditStore,
    nodeLifecycleService: lifecycleService([]),
    nodes: [hidden],
    scopedNodeIds: [],
  });

  const response = await app.request(`/api/v1/nodes/${hidden.id}/lifecycle/restart_service`, {
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "nodes.lifecycle.run.failed" });

  assert.equal(response.status, 404);
  assert.equal(event?.reason, "node_not_found");
  assert.equal(event?.permission, "node:manage");
  assert.equal(event?.target.id, hidden.id);
});

function nodeLifecycleApp({
  auditStore,
  nodeLifecycleService,
  nodes,
  scopedNodeIds,
}: {
  auditStore: ReturnType<typeof createAuditStore>;
  nodeLifecycleService: NodeLifecycleService;
  nodes: RecorderNode[];
  scopedNodeIds?: string[];
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
    meterFrameStore: memoryMeterFrameStore(),
    nodeLifecycleService,
    nodeStore: memoryNodeStore(nodes),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: requirePermission(),
    scopedNodes: async () =>
      nodes.filter(
        (candidate) => scopedNodeIds === undefined || scopedNodeIds.includes(candidate.id),
      ),
  });

  return app;
}

function lifecycleService(jobs: NodeLifecycleJob[]): NodeLifecycleService {
  return {
    async list(nodeId) {
      return jobs.filter((job) => !nodeId || job.nodeId === nodeId);
    },
    async run({ action, node, requestedBy }) {
      const job: NodeLifecycleJob = {
        action,
        completedAt: new Date().toISOString(),
        exitCode: 0,
        id: `node_lifecycle_${randomUUID()}`,
        nodeAlias: node.alias,
        nodeId: node.id,
        requestedAt: new Date().toISOString(),
        requestedBy,
        startedAt: new Date().toISOString(),
        status: "succeeded",
        targetHost: node.ipAddresses[0] ?? node.hostname,
      };

      jobs.unshift(job);

      return job;
    },
  };
}

function requirePermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: "user_node_lifecycle",
        name: "Node Lifecycle User",
        roles: ["operator"],
        type: "user",
      },
      actorContext: {},
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

function memoryMeterFrameStore(): MeterFrameStore {
  const frames: MeterFrame[] = [];

  return {
    async history() {
      return frames;
    },
    async latest() {
      return undefined;
    },
    async save(frame) {
      frames.unshift(frame);

      return { frame, receivedAt: new Date().toISOString() };
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

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "node-lifecycle@example.com",
    groups: [],
    id: "user_node_lifecycle",
    name: "Node Lifecycle User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Monitor Room",
    hostname: "monitor-room-node",
    id: "node_monitor_room",
    interfaces: [],
    ipAddresses: ["10.0.0.50"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Monitor Room",
      site: "Main Site",
    },
    status: "online",
    tags: ["voice"],
    ...input,
  };
}
