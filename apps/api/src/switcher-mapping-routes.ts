import type { Context, Hono } from "hono";

import {
  switcherMappingsUpdateSchema,
  type SwitcherInputMapping,
  type SwitcherOutputMapping,
  type SwitcherStatus,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { RoomStore } from "./room-store.js";
import { switcherSettingsTarget } from "./settings-scope.js";
import type { StoredSwitcherMappings, SwitcherMappingStore } from "./switcher-mapping-store.js";
import type { SwitcherStore } from "./switcher-store.js";

interface UserSummary {
  email?: string;
  id: string;
  name: string;
}

interface SwitcherMappingRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  listUsers: () => Promise<UserSummary[]>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  roomStore: RoomStore;
  switcherMappingStore: SwitcherMappingStore;
  switcherStore: SwitcherStore;
}

interface EnrichedMappings {
  inputs: SwitcherInputMapping[];
  outputs: SwitcherOutputMapping[];
}

// Validate a proposed mapping against the switcher's channel bounds, uniqueness
// (a channel and a room/user each appear at most once), and referential
// existence. Returns a human-readable reason on the first violation.
function validateMappings(
  switcher: SwitcherStatus,
  mappings: StoredSwitcherMappings,
  roomIds: Set<string>,
  userIds: Set<string>,
): string | undefined {
  const seenInputs = new Set<number>();
  const seenRooms = new Set<string>();

  for (const entry of mappings.inputs) {
    if (entry.input < 1 || entry.input > switcher.inputs) {
      return `input ${entry.input} is out of range 1..${switcher.inputs}`;
    }
    if (seenInputs.has(entry.input)) {
      return `input ${entry.input} is mapped more than once`;
    }
    if (seenRooms.has(entry.roomId)) {
      return `room ${entry.roomId} is mapped to more than one input`;
    }
    if (!roomIds.has(entry.roomId)) {
      return `unknown room ${entry.roomId}`;
    }
    seenInputs.add(entry.input);
    seenRooms.add(entry.roomId);
  }

  const seenOutputs = new Set<number>();
  const seenUsers = new Set<string>();

  for (const entry of mappings.outputs) {
    if (entry.output < 1 || entry.output > switcher.outputs) {
      return `output ${entry.output} is out of range 1..${switcher.outputs}`;
    }
    if (seenOutputs.has(entry.output)) {
      return `output ${entry.output} is mapped more than once`;
    }
    if (seenUsers.has(entry.userId)) {
      return `user ${entry.userId} is mapped to more than one output`;
    }
    if (!userIds.has(entry.userId)) {
      return `unknown user ${entry.userId}`;
    }
    seenOutputs.add(entry.output);
    seenUsers.add(entry.userId);
  }

  return undefined;
}

export function registerSwitcherMappingRoutes({
  app,
  currentAuth,
  listUsers,
  recordAuditEvent,
  requirePermission,
  roomStore,
  switcherMappingStore,
  switcherStore,
}: SwitcherMappingRouteDependencies) {
  const targetFor = async (c: Context<AppBindings>): Promise<AuditTarget> => {
    const id = c.req.param("id") ?? "";
    const switcher = await switcherStore.find(id);

    return switcher ? switcherSettingsTarget(switcher) : { id, type: "switcher" };
  };

  const enrich = async (mappings: StoredSwitcherMappings): Promise<EnrichedMappings> => {
    const [rooms, users] = await Promise.all([roomStore.list(), listUsers()]);
    const roomNames = new Map(rooms.map((room) => [room.id, room.name]));
    const userById = new Map(users.map((entry) => [entry.id, entry]));

    return {
      inputs: mappings.inputs.map((entry) => ({
        input: entry.input,
        roomId: entry.roomId,
        roomName: roomNames.get(entry.roomId),
      })),
      outputs: mappings.outputs.map((entry) => ({
        output: entry.output,
        userEmail: userById.get(entry.userId)?.email,
        userId: entry.userId,
        userName: userById.get(entry.userId)?.name,
      })),
    };
  };

  // Purpose-built picker directory for the mapping editor: the minimal
  // room + user lists needed to build the grid, gated by switcher:read so the
  // room's leading staff can map without admin user-management access.
  app.get(
    "/api/v1/settings/switcher-mapping-options",
    requirePermission("switcher:read", "settings.switchers.mapping_options.read", () => ({
      type: "switcher",
    })),
    async (c) => {
      const [rooms, users] = await Promise.all([roomStore.list(), listUsers()]);

      await recordAuditEvent(c, {
        action: "settings.switchers.mapping_options.read.succeeded",
        auth: currentAuth(c),
        details: { roomCount: rooms.length, userCount: users.length },
        outcome: "succeeded",
        permission: "switcher:read",
        target: { type: "switcher" },
      });

      return c.json({
        data: {
          rooms: rooms.map((room) => ({ id: room.id, name: room.name, site: room.site })),
          users: users.map((user) => ({ email: user.email, id: user.id, name: user.name })),
        },
      });
    },
  );

  app.get(
    "/api/v1/settings/switchers/:id/mappings",
    requirePermission("switcher:read", "settings.switchers.mappings.read", targetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const switcher = await switcherStore.find(id);

      if (!switcher) {
        await recordAuditEvent(c, {
          action: "settings.switchers.mappings.read.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "switcher:read",
          reason: "not_found",
          target: { id, type: "switcher" },
        });
        return c.json({ error: "Switcher not found" }, 404);
      }

      const mappings = await switcherMappingStore.get(id);
      const data = await enrich(mappings);

      await recordAuditEvent(c, {
        action: "settings.switchers.mappings.read.succeeded",
        auth: currentAuth(c),
        details: { inputCount: data.inputs.length, outputCount: data.outputs.length },
        outcome: "succeeded",
        permission: "switcher:read",
        target: switcherSettingsTarget(switcher),
      });

      return c.json({ data });
    },
  );

  app.put(
    "/api/v1/settings/switchers/:id/mappings",
    requirePermission("switcher:map", "settings.switchers.mappings.update", targetFor),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const switcher = await switcherStore.find(id);

      if (!switcher) {
        await recordAuditEvent(c, {
          action: "settings.switchers.mappings.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "switcher:map",
          reason: "not_found",
          target: { id, type: "switcher" },
        });
        return c.json({ error: "Switcher not found" }, 404);
      }

      const body = switcherMappingsUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordAuditEvent(c, {
          action: "settings.switchers.mappings.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "switcher:map",
          reason: "invalid_request",
          target: switcherSettingsTarget(switcher),
        });
        return c.json({ error: "Invalid mappings", issues: body.error.issues }, 400);
      }

      const proposed: StoredSwitcherMappings = {
        inputs: body.data.inputs.map((entry) => ({ input: entry.input, roomId: entry.roomId })),
        outputs: body.data.outputs.map((entry) => ({ output: entry.output, userId: entry.userId })),
      };
      const [rooms, users] = await Promise.all([roomStore.list(), listUsers()]);
      const invalid = validateMappings(
        switcher,
        proposed,
        new Set(rooms.map((room) => room.id)),
        new Set(users.map((entry) => entry.id)),
      );

      if (invalid) {
        await recordAuditEvent(c, {
          action: "settings.switchers.mappings.update.failed",
          auth: currentAuth(c),
          details: { reason: invalid },
          outcome: "failed",
          permission: "switcher:map",
          reason: "invalid_mapping",
          target: switcherSettingsTarget(switcher),
        });
        return c.json({ error: `Invalid mapping: ${invalid}` }, 400);
      }

      const before = await switcherMappingStore.get(id);
      const saved = await switcherMappingStore.replace(id, proposed);
      const data = await enrich(saved);

      await recordAuditEvent(c, {
        action: "settings.switchers.mappings.update.succeeded",
        after: { inputCount: saved.inputs.length, outputCount: saved.outputs.length },
        auth: currentAuth(c),
        before: { inputCount: before.inputs.length, outputCount: before.outputs.length },
        outcome: "succeeded",
        permission: "switcher:map",
        target: switcherSettingsTarget(switcher),
      });

      return c.json({ data });
    },
  );
}
