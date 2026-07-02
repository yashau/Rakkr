import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

import type { AuditEvent, Room, SwitcherStatus } from "@rakkr/shared";

import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";
import type { RoomStore } from "../src/room-store.js";
import type { SwitcherStore } from "../src/switcher-store.js";

const storeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-switcher-mappings-"));
process.env.RAKKR_SWITCHER_MAPPING_STORE_PATH = path.join(storeRoot, "mappings.json");

const { createSwitcherMappingStore } = await import("../src/switcher-mapping-store.js");
const { registerSwitcherMappingRoutes } = await import("../src/switcher-mapping-routes.js");

test.after(async () => {
  await rm(storeRoot, { force: true, recursive: true });
});

const switcher: SwitcherStatus = {
  createdAt: "2026-07-03T00:00:00.000Z",
  displayName: "Hansard Matrix",
  enabled: true,
  hasPassword: false,
  host: "172.22.195.101",
  id: "sw1",
  inputs: 24,
  mode: "observe",
  model: "avpro-ac-max",
  outputs: 24,
  port: 23,
  updatedAt: "2026-07-03T00:00:00.000Z",
};

const rooms: Room[] = [
  { id: "room_a", name: "Committee A", site: "HQ" },
  { id: "room_b", name: "Committee B", site: "HQ" },
];

const allowPermission: RequirePermission = () => async (_c, next) => {
  await next();
};

const recordAuditEvent: RecordAuditEvent = async (_c, input) => {
  const event: AuditEvent = {
    action: input.action,
    actor: input.actor ?? { id: "u", name: "U", roles: [], type: "user" },
    actorContext: {},
    createdAt: new Date().toISOString(),
    details: input.details ?? {},
    id: `audit_${randomUUID()}`,
    outcome: input.outcome,
    target: input.target,
  };

  return event;
};

const roomStore = {
  async create() {
    throw new Error("unused");
  },
  async delete() {
    return undefined;
  },
  async find(id: string) {
    return rooms.find((room) => room.id === id);
  },
  async list() {
    return rooms;
  },
  async update() {
    return undefined;
  },
} satisfies RoomStore;

const switcherStore = {
  async create() {
    throw new Error("unused");
  },
  async delete() {
    return false;
  },
  async find(id: string) {
    return id === switcher.id ? switcher : undefined;
  },
  async list() {
    return [switcher];
  },
  async resolveConfig() {
    return undefined;
  },
  async update() {
    return undefined;
  },
} satisfies SwitcherStore;

function buildApp() {
  const app = new Hono<AppBindings>();

  registerSwitcherMappingRoutes({
    app,
    currentAuth: () => ({ user: undefined }),
    listUsers: async () => [
      { email: "alice@example.com", id: "user_a", name: "Alice" },
      { id: "user_b", name: "Bob" },
    ],
    recordAuditEvent,
    requirePermission: allowPermission,
    roomStore,
    switcherMappingStore: createSwitcherMappingStore(),
    switcherStore,
  });

  return app;
}

function put(app: Hono<AppBindings>, body: unknown) {
  return app.request("/api/v1/settings/switchers/sw1/mappings", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

test("stores a valid mapping and enriches room/user names", async () => {
  const app = buildApp();

  const response = await put(app, {
    inputs: [{ input: 3, roomId: "room_a" }],
    outputs: [
      { output: 7, userId: "user_a" },
      { output: 9, userId: "user_b" },
    ],
  });

  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    data: {
      inputs: Array<{ input: number; roomId: string; roomName?: string }>;
      outputs: Array<{ output: number; userEmail?: string; userId: string; userName?: string }>;
    };
  };

  assert.deepEqual(body.data.inputs, [{ input: 3, roomId: "room_a", roomName: "Committee A" }]);
  assert.deepEqual(body.data.outputs, [
    { output: 7, userEmail: "alice@example.com", userId: "user_a", userName: "Alice" },
    // Bob has no email; JSON omits the undefined key.
    { output: 9, userId: "user_b", userName: "Bob" },
  ]);

  // GET reflects the saved mapping.
  const read = await app.request("/api/v1/settings/switchers/sw1/mappings");

  assert.equal(read.status, 200);

  const readBody = (await read.json()) as { data: { inputs: unknown[]; outputs: unknown[] } };

  assert.equal(readBody.data.inputs.length, 1);
  assert.equal(readBody.data.outputs.length, 2);
});

test("rejects out-of-range channels, duplicates, and unknown references", async () => {
  const app = buildApp();

  const outOfRange = await put(app, { inputs: [{ input: 99, roomId: "room_a" }], outputs: [] });
  assert.equal(outOfRange.status, 400);

  const duplicateInput = await put(app, {
    inputs: [
      { input: 5, roomId: "room_a" },
      { input: 5, roomId: "room_b" },
    ],
    outputs: [],
  });
  assert.equal(duplicateInput.status, 400);

  const duplicateRoom = await put(app, {
    inputs: [
      { input: 5, roomId: "room_a" },
      { input: 6, roomId: "room_a" },
    ],
    outputs: [],
  });
  assert.equal(duplicateRoom.status, 400);

  const unknownRoom = await put(app, {
    inputs: [{ input: 5, roomId: "room_missing" }],
    outputs: [],
  });
  assert.equal(unknownRoom.status, 400);

  const unknownUser = await put(app, {
    inputs: [],
    outputs: [{ output: 5, userId: "user_missing" }],
  });
  assert.equal(unknownUser.status, 400);
});

test("returns 404 for an unknown switcher", async () => {
  const app = buildApp();

  const response = await app.request("/api/v1/settings/switchers/nope/mappings");

  assert.equal(response.status, 404);
});

test("mapping options exposes room and user pickers", async () => {
  const app = buildApp();

  const response = await app.request("/api/v1/settings/switcher-mapping-options");

  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    data: { rooms: Array<{ id: string }>; users: Array<{ id: string }> };
  };

  assert.deepEqual(
    body.data.rooms.map((room) => room.id),
    ["room_a", "room_b"],
  );
  assert.deepEqual(
    body.data.users.map((user) => user.id),
    ["user_a", "user_b"],
  );
});
