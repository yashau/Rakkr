import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, Permission, RecorderNode } from "@rakkr/shared";
import type { AuthResult } from "../src/auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerNodeInventoryRoutes } = await import("../src/node-inventory-routes.js");

test("node list filters by status", async () => {
  const app = nodeInventoryApp({
    nodes: [
      node({ alias: "Online Room", id: "node_online", status: "online" }),
      node({ alias: "Offline Room", id: "node_offline", status: "offline" }),
    ],
    permissionCalls: [],
  });

  const response = await app.request("/api/v1/nodes?status=offline");
  const body = (await response.json()) as { data: RecorderNode[] };
  const invalidResponse = await app.request("/api/v1/nodes?status=unknown");

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((item) => item.id),
    ["node_offline"],
  );
  assert.equal(invalidResponse.status, 400);
});

test("node list filters by audio backend", async () => {
  const app = nodeInventoryApp({
    nodes: [
      nodeWithInterface({
        id: "node_alsa",
        interfaces: [
          {
            ...nodeWithInterface().interfaces[0]!,
            backend: "alsa",
          },
        ],
        runtime: { audioBackends: ["alsa"] },
      }),
      nodeWithInterface({
        id: "node_jack_recording",
        interfaces: [
          {
            ...nodeWithInterface().interfaces[0]!,
            backend: "jack",
            id: "iface_jack",
          },
        ],
        runtime: { audioBackends: ["jack", "pipewire"] },
        status: "recording",
      }),
      node({
        id: "node_pipewire_available",
        runtime: { audioBackends: ["pipewire"] },
        status: "offline",
      }),
    ],
    permissionCalls: [],
  });

  const jackResponse = await app.request("/api/v1/nodes?backend=jack");
  const jackBody = (await jackResponse.json()) as { data: RecorderNode[] };
  const combinedResponse = await app.request("/api/v1/nodes?backend=pipewire&status=recording");
  const combinedBody = (await combinedResponse.json()) as { data: RecorderNode[] };
  const invalidResponse = await app.request("/api/v1/nodes?backend=oss");

  assert.equal(jackResponse.status, 200);
  assert.deepEqual(
    jackBody.data.map((item) => item.id),
    ["node_jack_recording"],
  );
  assert.equal(combinedResponse.status, 200);
  assert.deepEqual(
    combinedBody.data.map((item) => item.id),
    ["node_jack_recording"],
  );
  assert.equal(invalidResponse.status, 400);
});

test("node list filters by location hierarchy", async () => {
  const app = nodeInventoryApp({
    nodes: [
      node({
        id: "node_chamber",
        location: {
          building: "City Hall",
          floor: "2",
          room: "Council Room",
          site: "Main Site",
        },
      }),
      node({
        id: "node_overflow",
        location: {
          building: "City Hall",
          floor: "1",
          room: "Overflow",
          site: "Main Site",
        },
      }),
      node({
        id: "node_remote",
        location: {
          room: "Council Room",
          site: "Remote",
        },
      }),
    ],
    permissionCalls: [],
  });

  const response = await app.request(
    "/api/v1/nodes?site=main%20site&building=city%20hall&floor=2&room=council%20room",
  );
  const body = (await response.json()) as { data: RecorderNode[] };
  const invalidResponse = await app.request(`/api/v1/nodes?site=${"x".repeat(161)}`);

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((item) => item.id),
    ["node_chamber"],
  );
  assert.equal(invalidResponse.status, 400);
});

test("node list searches inventory identity fields", async () => {
  const chamberNode = nodeWithInterface({
    alias: "Council Chamber",
    id: "node_chamber",
    location: {
      building: "City Hall",
      room: "Council Room",
      site: "Main Site",
    },
    status: "recording",
    tags: ["voice", "public-meeting"],
  });
  const app = nodeInventoryApp({
    nodes: [node({ id: "node_monitor" }), chamberNode],
    permissionCalls: [],
  });

  const searchResponse = await app.request("/api/v1/nodes?q=MONITOR-USB-1");
  const searchBody = (await searchResponse.json()) as { data: RecorderNode[] };
  const combinedResponse = await app.request("/api/v1/nodes?status=recording&q=city");
  const combinedBody = (await combinedResponse.json()) as { data: RecorderNode[] };

  assert.equal(searchResponse.status, 200);
  assert.deepEqual(
    searchBody.data.map((item) => item.id),
    ["node_chamber"],
  );
  assert.equal(combinedResponse.status, 200);
  assert.deepEqual(
    combinedBody.data.map((item) => item.id),
    ["node_chamber"],
  );
});

test("node export returns filtered inventory CSV and audits access", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const app = nodeInventoryApp({
    auditStore,
    nodes: [
      nodeWithInterface({
        id: "node_alsa",
        interfaces: [
          {
            ...nodeWithInterface().interfaces[0]!,
            backend: "alsa",
          },
        ],
        runtime: { audioBackends: ["alsa"] },
      }),
      nodeWithInterface({
        alias: "Jack Recorder",
        id: "node_jack_recording",
        interfaces: [
          {
            ...nodeWithInterface().interfaces[0]!,
            backend: "jack",
            id: "iface_jack",
            sampleRates: [48_000, 96_000],
            serialNumber: "JACK-USB-1",
            systemName: "system:capture_1",
          },
        ],
        notes: "Rack shelf B",
        runtime: {
          architecture: "x64",
          audioBackends: ["jack", "pipewire"],
          kernelRelease: "6.8.0",
          osName: "Debian",
        },
        status: "recording",
      }),
      node({
        id: "node_pipewire_available",
        runtime: { audioBackends: ["pipewire"] },
        status: "offline",
      }),
    ],
    permissionCalls,
  });

  const response = await app.request("/api/v1/nodes/export?backend=jack&status=recording");
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "nodes.export.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="rakkr-nodes-\d{4}-\d{2}-\d{2}T/u,
  );
  assert.match(csv, /^id,alias,status,site,building,floor,room,hostname,/u);
  assert.match(csv, /node_jack_recording/u);
  assert.match(csv, /system:capture_1/u);
  assert.match(csv, /rates=48000\/96000/u);
  assert.match(csv, /Rack shelf B/u);
  assert.doesNotMatch(csv, /node_alsa/u);
  assert.doesNotMatch(csv, /node_pipewire_available/u);
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.export",
    permission: "node:read",
    target: undefined,
  });
  assert.equal(event?.permission, "node:read");
  assert.equal(event?.details.exportedCount, 1);
  assert.equal(event?.details.filters.backend, "jack");
  assert.equal(event?.details.filters.status, "recording");
  assert.equal(event?.target.id, "node_collection");
  assert.equal(event?.target.type, "node_collection");
});

test("node selected export preserves requested order and audits selection", async () => {
  const auditStore = createAuditStore("");
  const permissionCalls: PermissionCall[] = [];
  const nodes = [
    nodeWithInterface({ alias: "First Recorder", id: "node_selected_first" }),
    nodeWithInterface({ alias: "Second Recorder", id: "node_selected_second" }),
  ];
  const app = nodeInventoryApp({
    auditStore,
    nodes,
    permissionCalls,
  });

  const response = await app.request("/api/v1/nodes/export", {
    body: JSON.stringify({
      nodeIds: ["node_selected_second", "node_selected_first", "node_selected_second"],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const csv = await response.text();
  const [event] = await auditStore.list({ action: "nodes.export_selected.succeeded" });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert(csv.indexOf("node_selected_second") < csv.indexOf("node_selected_first"));
  assert.deepEqual(permissionCalls.at(-1), {
    action: "nodes.export_selected",
    permission: "node:read",
    target: { id: "node_collection", type: "node_collection" },
  });
  assert.equal(event?.permission, "node:read");
  assert.equal(event?.target.id, "node_collection");
  assert.equal(event?.details.requestedCount, 3);
  assert.equal(event?.details.exportedCount, 2);
  assert.deepEqual(event?.correlationIds, {
    nodeId1: "node_selected_second",
    nodeId2: "node_selected_first",
  });
});

test("node selected export rejects hidden nodes before exporting", async () => {
  const auditStore = createAuditStore("");
  const app = nodeInventoryApp({
    auditStore,
    nodes: [nodeWithInterface({ id: "node_visible" })],
    permissionCalls: [],
  });

  const response = await app.request("/api/v1/nodes/export", {
    body: JSON.stringify({ nodeIds: ["node_visible", "node_hidden"] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const [event] = await auditStore.list({ action: "nodes.export_selected.failed" });

  assert.equal(response.status, 404);
  assert.equal(event?.outcome, "denied");
  assert.equal(event?.permission, "node:read");
  assert.equal(event?.reason, "node_not_visible");
  assert.deepEqual(event?.details.hiddenIds, ["node_hidden"]);
  assert.deepEqual(event?.details.nodeIds, ["node_visible", "node_hidden"]);
});

interface PermissionCall {
  action: string;
  permission: Permission;
  target?: AuditTarget;
}

function nodeInventoryApp({
  auditStore = createAuditStore(""),
  currentUser = user(),
  nodes,
  permissionCalls,
}: {
  auditStore?: ReturnType<typeof createAuditStore>;
  currentUser?: CurrentUser;
  nodes: RecorderNode[];
  permissionCalls: PermissionCall[];
}) {
  const app = new Hono<AppBindings>();

  registerNodeInventoryRoutes({
    app,
    currentAuth: () => auth(currentUser),
    currentUser: () => currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: requirePermission(permissionCalls),
    scopedNodes: async () => nodes,
  });

  return app;
}

function requirePermission(calls: PermissionCall[]): RequirePermission {
  return (permission, action, target) => {
    return async (c, next) => {
      calls.push({
        action,
        permission,
        target: target ? await target(c) : undefined,
      });
      await next();
    };
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: "user_node_inventory",
        name: "Node Inventory User",
        roles: ["operator"],
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

function auth(currentUser = user()): AuthResult {
  return { user: currentUser };
}

function user(permissions: Permission[] = ["node:read"]): CurrentUser {
  return {
    email: "node-inventory@example.com",
    groups: [],
    id: "user_node_inventory",
    name: "Node Inventory User",
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

function nodeWithInterface(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    ...node(),
    interfaces: [
      {
        alias: "Monitor USB",
        backend: "alsa",
        channelCount: 2,
        channels: [
          { alias: "Channel 1", index: 1 },
          { alias: "Channel 2", index: 2 },
        ],
        hardwarePath: "/proc/asound/card1/pcm0c",
        id: "iface_monitor",
        sampleRates: [48_000],
        serialNumber: "MONITOR-USB-1",
        systemName: "Monitor USB Interface",
        systemRef: "usb-1-1",
      },
    ],
    ...input,
  };
}
