import type { Context, Hono } from "hono";
import {
  accessGroupCreateRequestSchema,
  accessGroupMembersReplaceRequestSchema,
  accessGroupUpdateRequestSchema,
  type AccessGroupDetail,
  type Permission,
} from "@rakkr/shared";

import { AuthError, LocalAuthService, type AuthResult } from "./auth-service.js";
import { actionState } from "./auth-management-routes.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";

interface AuthGroupRouteDependencies {
  app: Hono<AppBindings>;
  authService: LocalAuthService;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  // Cascade cleanup when a group is deleted: strip its roster grants and its ids
  // from schedule assignments (returns the number of schedules updated).
  removeGroupFromRoster: (groupId: string) => Promise<void>;
  removeGroupFromSchedules: (groupId: string) => Promise<number>;
  requirePermission: RequirePermission;
}

// First-party access-group management routes (create/detail/rename/members/delete),
// all gated on `auth:manage`. Split out of auth-management-routes.ts to keep each
// module within the LOC budget.
export function registerAuthGroupRoutes({
  app,
  authService,
  currentAuth,
  currentUser,
  recordAuditEvent,
  removeGroupFromRoster,
  removeGroupFromSchedules,
  requirePermission,
}: AuthGroupRouteDependencies) {
  app.post(
    "/api/v1/auth/groups",
    requirePermission("auth:manage", "auth.groups.create", () => ({ type: "auth" })),
    async (c) => {
      const body = accessGroupCreateRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordGroupActionFailure(
          c,
          "auth.groups.create.failed",
          undefined,
          "invalid_request",
        );
        return c.json({ error: "Invalid access group", issues: body.error.issues }, 400);
      }

      const unknownMembers = await unknownMemberIds(body.data.memberIds);

      if (unknownMembers.length > 0) {
        await recordGroupActionFailure(c, "auth.groups.create.failed", undefined, "unknown_member");
        return c.json({ error: "Unknown member ids", unknownMemberIds: unknownMembers }, 400);
      }

      try {
        const created = await authService.groups.createGroup(body.data);

        await recordAuditEvent(c, {
          action: "auth.groups.create.succeeded",
          after: groupSnapshot(created),
          auth: currentAuth(c),
          details: { memberCount: created.memberCount },
          outcome: "succeeded",
          permission: "auth:manage",
          target: { id: created.id, name: created.name, type: "group" },
        });

        return c.json({ data: created }, 201);
      } catch (error) {
        const reason = error instanceof AuthError ? error.code : "unknown_group_create_error";

        await recordGroupActionFailure(c, "auth.groups.create.failed", undefined, reason);
        return c.json({ error: "Access group unavailable" }, 503);
      }
    },
  );

  app.get(
    "/api/v1/auth/groups/:groupId",
    requirePermission("auth:manage", "auth.groups.detail.read", groupTarget),
    async (c) => {
      const group = await authService.groups.group(c.req.param("groupId"));

      if (!group) {
        await recordGroupActionFailure(
          c,
          "auth.groups.detail.read.failed",
          c.req.param("groupId"),
          "group_not_found",
        );
        return c.json({ error: "Group not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "auth.groups.detail.read.succeeded",
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "auth:manage",
        target: { id: group.id, name: group.name, type: "group" },
      });

      return c.json({
        data: {
          actions: authGroupActions(group, currentUser(c).permissions),
          group,
          links: authGroupLinks(group.id),
        },
      });
    },
  );

  app.patch(
    "/api/v1/auth/groups/:groupId",
    requirePermission("auth:manage", "auth.groups.update", groupTarget),
    async (c) => {
      const groupId = c.req.param("groupId");
      const body = accessGroupUpdateRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordGroupActionFailure(c, "auth.groups.update.failed", groupId, "invalid_request");
        return c.json({ error: "Invalid group update", issues: body.error.issues }, 400);
      }

      const before = await authService.groups.group(groupId);

      if (!before) {
        await recordGroupActionFailure(c, "auth.groups.update.failed", groupId, "group_not_found");
        return c.json({ error: "Group not found" }, 404);
      }

      let updated: AccessGroupDetail | undefined;

      try {
        updated = await authService.groups.updateGroup(groupId, body.data);
      } catch {
        await recordGroupActionFailure(
          c,
          "auth.groups.update.failed",
          groupId,
          "database_unavailable",
        );
        return c.json({ error: "Access group unavailable" }, 503);
      }

      if (!updated) {
        await recordGroupActionFailure(c, "auth.groups.update.failed", groupId, "group_not_found");
        return c.json({ error: "Group not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "auth.groups.update.succeeded",
        after: groupSnapshot(updated),
        auth: currentAuth(c),
        before: groupSnapshot(before),
        outcome: "succeeded",
        permission: "auth:manage",
        target: { id: updated.id, name: updated.name, type: "group" },
      });

      return c.json({ data: updated });
    },
  );

  app.put(
    "/api/v1/auth/groups/:groupId/members",
    requirePermission("auth:manage", "auth.groups.members.update", groupTarget),
    async (c) => {
      const groupId = c.req.param("groupId");
      const body = accessGroupMembersReplaceRequestSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );

      if (!body.success) {
        await recordGroupActionFailure(
          c,
          "auth.groups.members.update.failed",
          groupId,
          "invalid_request",
        );
        return c.json({ error: "Invalid group members", issues: body.error.issues }, 400);
      }

      const unknownMembers = await unknownMemberIds(body.data.memberIds);

      if (unknownMembers.length > 0) {
        await recordGroupActionFailure(
          c,
          "auth.groups.members.update.failed",
          groupId,
          "unknown_member",
        );
        return c.json({ error: "Unknown member ids", unknownMemberIds: unknownMembers }, 400);
      }

      const before = await authService.groups.group(groupId);

      if (!before) {
        await recordGroupActionFailure(
          c,
          "auth.groups.members.update.failed",
          groupId,
          "group_not_found",
        );
        return c.json({ error: "Group not found" }, 404);
      }

      let updated: AccessGroupDetail | undefined;

      try {
        updated = await authService.groups.setGroupMembers(groupId, body.data.memberIds);
      } catch {
        await recordGroupActionFailure(
          c,
          "auth.groups.members.update.failed",
          groupId,
          "database_unavailable",
        );
        return c.json({ error: "Access group unavailable" }, 503);
      }

      if (!updated) {
        await recordGroupActionFailure(
          c,
          "auth.groups.members.update.failed",
          groupId,
          "group_not_found",
        );
        return c.json({ error: "Group not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "auth.groups.members.update.succeeded",
        after: groupSnapshot(updated),
        auth: currentAuth(c),
        before: groupSnapshot(before),
        details: { memberCount: updated.memberCount },
        outcome: "succeeded",
        permission: "auth:manage",
        target: { id: updated.id, name: updated.name, type: "group" },
      });

      return c.json({ data: updated });
    },
  );

  app.delete(
    "/api/v1/auth/groups/:groupId",
    requirePermission("auth:manage", "auth.groups.delete", groupTarget),
    async (c) => {
      const groupId = c.req.param("groupId");
      const before = await authService.groups.group(groupId);

      if (!before) {
        await recordGroupActionFailure(c, "auth.groups.delete.failed", groupId, "group_not_found");
        return c.json({ error: "Group not found" }, 404);
      }

      let deleted: { id: string; name: string } | undefined;
      let schedulesUpdated = 0;

      try {
        deleted = await authService.groups.deleteGroup(groupId);

        if (deleted) {
          await removeGroupFromRoster(groupId);
          schedulesUpdated = await removeGroupFromSchedules(groupId);
        }
      } catch {
        await recordGroupActionFailure(
          c,
          "auth.groups.delete.failed",
          groupId,
          "database_unavailable",
        );
        return c.json({ error: "Access group unavailable" }, 503);
      }

      if (!deleted) {
        await recordGroupActionFailure(c, "auth.groups.delete.failed", groupId, "group_not_found");
        return c.json({ error: "Group not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "auth.groups.delete.succeeded",
        auth: currentAuth(c),
        before: groupSnapshot(before),
        details: { memberCount: before.memberCount, schedulesUpdated },
        outcome: "succeeded",
        permission: "auth:manage",
        target: { id: before.id, name: before.name, type: "group" },
      });

      return c.json({ data: deleted });
    },
  );

  function groupTarget(c: Context<AppBindings>) {
    return {
      id: c.req.param("groupId"),
      type: "group",
    };
  }

  async function unknownMemberIds(memberIds: readonly string[]) {
    const known = new Set((await authService.localUsers()).map((user) => user.id));

    return [...new Set(memberIds)].filter((memberId) => !known.has(memberId));
  }

  async function recordGroupActionFailure(
    c: Context<AppBindings>,
    action: string,
    groupId: string | undefined,
    reason: string,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: "auth:manage",
      reason,
      target: groupId ? { id: groupId, type: "group" } : { type: "group" },
    });
  }
}

function authGroupActions(group: AccessGroupDetail, permissions: readonly Permission[]) {
  const basePath = `/api/v1/auth/groups/${group.id}`;

  return {
    delete: actionState({
      href: basePath,
      method: "DELETE",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    detail: actionState({
      href: basePath,
      method: "GET",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    updateGroup: actionState({
      href: basePath,
      method: "PATCH",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    updateMembers: actionState({
      href: `${basePath}/members`,
      method: "PUT",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
  };
}

function authGroupLinks(groupId: string) {
  const basePath = `/api/v1/auth/groups/${groupId}`;

  return {
    delete: basePath,
    detail: basePath,
    members: `${basePath}/members`,
    update: basePath,
  };
}

function groupSnapshot(group: AccessGroupDetail | undefined) {
  return {
    description: group?.description,
    id: group?.id,
    memberIds: group?.members.map((member) => member.id) ?? [],
    name: group?.name,
  };
}
