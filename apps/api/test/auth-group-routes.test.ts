import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const rosterStoreRoot = await mkdtemp(path.join(tmpdir(), "rakkr-auth-group-roster-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_LOCAL_ACCESS_POLICIES = "";
process.env.RAKKR_LOCAL_ADMIN_GROUPS = "";
process.env.RAKKR_ROOM_ROSTER_STORE_PATH = path.join(rosterStoreRoot, "room-roster.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAuthGroupRoutes } = await import("../src/auth-group-routes.js");
const { LocalAuthService } = await import("../src/auth-service.js");
const { createRoomRosterStore } = await import("../src/room-roster-store.js");

test.after(async () => {
  await rm(rosterStoreRoot, { force: true, recursive: true });
});

test("group routes support create with slug, membership, and cascade-clean delete", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const authService = new LocalAuthService("");
  const localAdmin = await authService.localAdmin();
  const currentUser = manager(localAdmin);
  const rosterRemovals: string[] = [];
  const scheduleRemovals: string[] = [];

  registerAuthGroupRoutes({
    app,
    authService,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    removeGroupFromRoster: async (groupId) => {
      rosterRemovals.push(groupId);
    },
    removeGroupFromSchedules: async (groupId) => {
      scheduleRemovals.push(groupId);
      return 2;
    },
    requirePermission: allowPermission(),
  });

  const createResponse = await app.request("/api/v1/auth/groups", {
    body: JSON.stringify({
      description: "Ops",
      memberIds: [localAdmin.id],
      name: "Room Operators",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const created = (await createResponse.json()) as {
    data: { id: string; memberCount: number };
  };

  assert.equal(createResponse.status, 201);
  assert.equal(created.data.id, "room-operators", "id is a name-derived slug");
  assert.equal(created.data.memberCount, 1);

  const unknownMemberResponse = await app.request("/api/v1/auth/groups", {
    body: JSON.stringify({ memberIds: ["user_missing"], name: "Bad" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(unknownMemberResponse.status, 400, "unknown members are rejected");

  const renameResponse = await app.request(`/api/v1/auth/groups/${created.data.id}`, {
    body: JSON.stringify({ name: "Operators" }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  const renamed = (await renameResponse.json()) as { data: { id: string; name: string } };

  assert.equal(renameResponse.status, 200);
  assert.equal(renamed.data.id, created.data.id, "id is immutable across rename");
  assert.equal(renamed.data.name, "Operators");

  const membersResponse = await app.request(`/api/v1/auth/groups/${created.data.id}/members`, {
    body: JSON.stringify({ memberIds: [] }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  const membersBody = (await membersResponse.json()) as { data: { memberCount: number } };

  assert.equal(membersResponse.status, 200);
  assert.equal(membersBody.data.memberCount, 0);

  const deleteResponse = await app.request(`/api/v1/auth/groups/${created.data.id}`, {
    method: "DELETE",
  });

  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(rosterRemovals, [created.data.id], "delete strips roster grants");
  assert.deepEqual(scheduleRemovals, [created.data.id], "delete strips schedule assignments");

  const goneResponse = await app.request(`/api/v1/auth/groups/${created.data.id}`);

  assert.equal(goneResponse.status, 404);

  const successActions = (
    await auditStore.list({ outcome: "succeeded", permission: "auth:manage" })
  ).map((event) => event.action);

  for (const action of [
    "auth.groups.create.succeeded",
    "auth.groups.update.succeeded",
    "auth.groups.members.update.succeeded",
    "auth.groups.delete.succeeded",
  ]) {
    assert.ok(successActions.includes(action), `expected audit ${action}`);
  }
});

test("deleting a group cascade-cleans its room roster grants end-to-end", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const authService = new LocalAuthService("");
  const currentUser = manager(await authService.localAdmin());
  const rosterStore = createRoomRosterStore();

  registerAuthGroupRoutes({
    app,
    authService,
    currentAuth: () => ({ user: currentUser }),
    currentUser: () => currentUser,
    recordAuditEvent: recordAuditEvent(auditStore),
    // Wire the REAL roster store (not a stub) so the delete → cascade composition
    // is exercised end-to-end, not just the fact that the callback is invoked.
    removeGroupFromRoster: (groupId) => rosterStore.removeGroupSubject(groupId),
    removeGroupFromSchedules: async () => 0,
    requirePermission: allowPermission(),
  });

  const createResponse = await app.request("/api/v1/auth/groups", {
    body: JSON.stringify({ memberIds: [], name: "Doomed" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const { data: created } = (await createResponse.json()) as { data: { id: string } };

  await rosterStore.replaceManual("room_cascade", [
    { capabilities: ["operate"], subjectId: created.id, subjectType: "group" },
    { capabilities: ["view"], subjectId: "user_keep", subjectType: "user" },
  ]);

  const before = await rosterStore.effectiveCapabilities(
    { groupIds: [created.id], userId: "member" },
    "room_cascade",
  );
  assert.deepEqual([...before], ["operate"], "the group's roster grant is live before delete");

  const deleteResponse = await app.request(`/api/v1/auth/groups/${created.id}`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 200);

  const groupAfter = await rosterStore.effectiveCapabilities(
    { groupIds: [created.id], userId: "member" },
    "room_cascade",
  );
  assert.equal(groupAfter.size, 0, "the deleted group's roster grant is cascade-cleaned");

  const userAfter = await rosterStore.effectiveCapabilities(
    { groupIds: [], userId: "user_keep" },
    "room_cascade",
  );
  assert.deepEqual([...userAfter], ["view"], "unrelated user roster rows survive");
});

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: {
        id: input.auth?.user?.id ?? "user_group_routes_test",
        name: input.auth?.user?.name ?? "Group Routes Test",
        roles: input.auth?.user?.roles ?? [],
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

function manager(base: CurrentUser): CurrentUser {
  return {
    ...base,
    permissions: ["auth:manage"],
    roles: ["owner"],
  };
}
