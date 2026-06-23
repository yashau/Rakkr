import { z } from "zod";
import type { Context, Hono } from "hono";
import {
  accessGroupIdSchema,
  accessPolicyInputSchema,
  resourceGrantSchema,
  roleSchema,
  type CurrentUser,
  type Permission,
} from "@rakkr/shared";

import { AuthError, LocalAuthService, type AuthResult } from "./auth-service.js";
import { accessKeepsAuthManage, accessSnapshot, localAdminId } from "./auth-utils.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";

interface AuthManagementRouteDependencies {
  app: Hono<AppBindings>;
  authService: LocalAuthService;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

interface AuthActionState {
  enabled: boolean;
  href?: string;
  method: "DELETE" | "GET" | "PATCH" | "POST";
  payload?: Record<string, unknown>;
  permission: Permission;
  reason?: string;
}

const userAccessRequestSchema = z
  .object({
    groupIds: z.array(accessGroupIdSchema).max(64).default([]),
    resourceGrants: z.array(resourceGrantSchema).default([]),
    roles: z.array(roleSchema).min(1),
  })
  .strict();
const localUserCreateRequestSchema = userAccessRequestSchema.extend({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(160),
  password: z.string().min(8).max(200),
});
const accessPolicyUpdateSchema = z.object({
  policies: z.array(accessPolicyInputSchema).default([]),
});

export function registerAuthManagementRoutes({
  app,
  authService,
  currentAuth,
  currentUser,
  recordAuditEvent,
  requirePermission,
}: AuthManagementRouteDependencies) {
  app.get(
    "/api/v1/auth/actions",
    requirePermission("auth:manage", "auth.actions.read", () => ({ type: "auth" })),
    async (c) => {
      const actions = authRootActions(currentUser(c).permissions);

      await recordAuditEvent(c, {
        action: "auth.actions.read.succeeded",
        auth: currentAuth(c),
        details: {
          visibleActionCount: Object.keys(actions).length,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          type: "auth",
        },
      });

      return c.json({
        data: {
          actions,
          links: authRootLinks(),
        },
      });
    },
  );

  app.get(
    "/api/v1/auth/groups",
    requirePermission("auth:manage", "auth.groups.read", () => ({ type: "auth" })),
    async (c) => {
      const groups = await authService.localGroups();

      await recordAuditEvent(c, {
        action: "auth.groups.read.succeeded",
        auth: currentAuth(c),
        details: {
          count: groups.length,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          type: "auth",
        },
      });

      return c.json({ data: groups });
    },
  );

  app.get(
    "/api/v1/auth/users",
    requirePermission("auth:manage", "auth.users.read", () => ({ type: "auth" })),
    async (c) => {
      const users = await authService.localUsers();

      await recordAuditEvent(c, {
        action: "auth.users.read.succeeded",
        auth: currentAuth(c),
        details: {
          count: users.length,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          type: "auth",
        },
      });

      return c.json({ data: users });
    },
  );

  app.post(
    "/api/v1/auth/users",
    requirePermission("auth:manage", "auth.users.create", () => ({ type: "auth" })),
    async (c) => {
      const body = localUserCreateRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordAuditEvent(c, {
          action: "auth.users.create.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "auth:manage",
          reason: "invalid_request",
          target: {
            type: "user",
          },
        });

        return c.json({ error: "Invalid local user", issues: body.error.issues }, 400);
      }

      try {
        const created = await authService.createLocalUser(body.data);

        await recordAuditEvent(c, {
          action: "auth.users.create.succeeded",
          after: accessSnapshot(created),
          auth: currentAuth(c),
          details: {
            email: created.email,
            provider: created.provider,
          },
          outcome: "succeeded",
          permission: "auth:manage",
          target: {
            id: created.id,
            name: created.email,
            type: "user",
          },
        });

        return c.json({ data: created }, 201);
      } catch (error) {
        const reason = error instanceof AuthError ? error.code : "unknown_user_create_error";

        await recordAuditEvent(c, {
          action: "auth.users.create.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "auth:manage",
          reason,
          target: {
            name: body.data.email,
            type: "user",
          },
        });

        return c.json(
          {
            error:
              reason === "user_exists" ? "Local user already exists" : "Local user unavailable",
          },
          reason === "user_exists" ? 409 : 503,
        );
      }
    },
  );

  app.get(
    "/api/v1/auth/users/:userId",
    requirePermission("auth:manage", "auth.users.detail.read", userTarget),
    async (c) => {
      const user = await authService.localUser(c.req.param("userId"));

      if (!user) {
        await recordUserReadFailure(c, c.req.param("userId"), "auth.users.detail.read.failed");
        return c.json({ error: "User not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "auth.users.detail.read.succeeded",
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          id: user.id,
          name: user.email,
          type: "user",
        },
      });

      return c.json({
        data: {
          actions: authUserActions(user, currentUser(c), currentUser(c).permissions),
          links: authUserLinks(user.id),
          user,
        },
      });
    },
  );

  app.get(
    "/api/v1/auth/users/:userId/actions",
    requirePermission("auth:manage", "auth.users.actions.read", userTarget),
    async (c) => {
      const user = await authService.localUser(c.req.param("userId"));

      if (!user) {
        await recordUserReadFailure(c, c.req.param("userId"), "auth.users.actions.read.failed");
        return c.json({ error: "User not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "auth.users.actions.read.succeeded",
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          id: user.id,
          name: user.email,
          type: "user",
        },
      });

      return c.json({
        data: {
          actions: authUserActions(user, currentUser(c), currentUser(c).permissions),
          links: authUserLinks(user.id),
          user,
        },
      });
    },
  );

  app.get(
    "/api/v1/auth/access-policies",
    requirePermission("auth:manage", "auth.access_policies.read", () => ({ type: "auth" })),
    async (c) => {
      const policies = await authService.accessPolicies();

      await recordAuditEvent(c, {
        action: "auth.access_policies.read.succeeded",
        auth: currentAuth(c),
        details: {
          count: policies.length,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          type: "auth",
        },
      });

      return c.json({ data: policies });
    },
  );

  app.get(
    "/api/v1/auth/access-policies/actions",
    requirePermission("auth:manage", "auth.access_policies.actions.read", () => ({ type: "auth" })),
    async (c) => {
      const policies = await authService.accessPolicies();
      const actions = accessPolicyActions(currentUser(c).permissions);

      await recordAuditEvent(c, {
        action: "auth.access_policies.actions.read.succeeded",
        auth: currentAuth(c),
        details: {
          policyCount: policies.length,
          visibleActionCount: Object.keys(actions).length,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          type: "auth",
        },
      });

      return c.json({
        data: {
          actions,
          links: accessPolicyLinks(),
          policies,
        },
      });
    },
  );

  app.patch(
    "/api/v1/auth/access-policies",
    requirePermission("auth:manage", "auth.access_policies.update", () => ({ type: "auth" })),
    async (c) => {
      const body = accessPolicyUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordAuditEvent(c, {
          action: "auth.access_policies.update.failed",
          auth: currentAuth(c),
          outcome: "failed",
          permission: "auth:manage",
          reason: "invalid_request",
          target: {
            type: "auth",
          },
        });

        return c.json({ error: "Invalid access policies", issues: body.error.issues }, 400);
      }

      const before = await authService.accessPolicies();
      const updated = await authService.updateLocalAccessPolicies(
        body.data.policies,
        currentUser(c).id,
      );

      await recordAuditEvent(c, {
        action: "auth.access_policies.update.succeeded",
        after: {
          policies: updated,
        },
        auth: currentAuth(c),
        before: {
          policies: before,
        },
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          type: "auth",
        },
      });

      return c.json({ data: updated });
    },
  );

  app.patch(
    "/api/v1/auth/users/:userId/access",
    requirePermission("auth:manage", "auth.users.access.update", userTarget),
    async (c) => {
      const userId = c.req.param("userId");
      const body = userAccessRequestSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordUserAccessUpdateFailure(c, userId, "invalid_request");
        return c.json({ error: "Invalid access update", issues: body.error.issues }, 400);
      }

      if (userId === currentUser(c).id && !accessKeepsAuthManage(body.data.roles)) {
        await recordUserAccessUpdateFailure(c, userId, "self_auth_manage_required");
        return c.json({ error: "Local access manager must keep auth:manage" }, 400);
      }

      const before = await authService.localUser(userId);
      let updated: CurrentUser | undefined;

      try {
        updated = await authService.updateLocalUserAccess(userId, body.data);
      } catch (error) {
        const reason = error instanceof AuthError ? error.code : "unknown_access_update_error";

        await recordUserAccessUpdateFailure(c, userId, reason);
        return c.json({ error: "Local user access unavailable" }, 503);
      }

      if (!updated) {
        await recordUserAccessUpdateFailure(c, userId, "user_not_found");
        return c.json({ error: "User not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "auth.users.access.update.succeeded",
        after: accessSnapshot(updated),
        auth: currentAuth(c),
        before: accessSnapshot(before),
        outcome: "succeeded",
        permission: "auth:manage",
        target: {
          id: updated.id,
          name: updated.email,
          type: "user",
        },
      });

      return c.json({ data: updated });
    },
  );

  function userTarget(c: Context<AppBindings>) {
    return {
      id: c.req.param("userId"),
      type: "user",
    };
  }

  async function recordUserAccessUpdateFailure(
    c: Context<AppBindings>,
    userId: string,
    reason: string,
  ) {
    await recordAuditEvent(c, {
      action: "auth.users.access.update.failed",
      auth: currentAuth(c),
      outcome: "failed",
      permission: "auth:manage",
      reason,
      target: {
        id: userId,
        type: "user",
      },
    });
  }

  async function recordUserReadFailure(c: Context<AppBindings>, userId: string, action: string) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: "auth:manage",
      reason: "user_not_found",
      target: {
        id: userId,
        type: "user",
      },
    });
  }
}

function authRootActions(permissions: readonly Permission[]) {
  return {
    createUser: actionState({
      href: "/api/v1/auth/users",
      method: "POST",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    groups: actionState({
      href: "/api/v1/auth/groups",
      method: "GET",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    listUsers: actionState({
      href: "/api/v1/auth/users",
      method: "GET",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    policies: actionState({
      href: "/api/v1/auth/access-policies",
      method: "GET",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    updatePolicies: actionState({
      href: "/api/v1/auth/access-policies",
      method: "PATCH",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
  };
}

function authUserActions(
  user: CurrentUser,
  actor: NonNullable<AuthResult["user"]>,
  permissions: readonly Permission[],
) {
  const basePath = `/api/v1/auth/users/${user.id}`;
  const disabled = Boolean(user.disabledAt);

  return {
    delete: actionState({
      href: basePath,
      method: "DELETE",
      permission: "auth:manage",
      permissions,
      ready: user.id !== actor.id && user.id !== localAdminId(),
      reason: deleteReason(user, actor),
    }),
    detail: actionState({
      href: basePath,
      method: "GET",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    disable: actionState({
      href: `${basePath}/status`,
      method: "PATCH",
      payload: { disabled: true },
      permission: "auth:manage",
      permissions,
      ready: user.id !== actor.id && user.id !== localAdminId() && !disabled,
      reason: disableReason(user, actor),
    }),
    enable: actionState({
      href: `${basePath}/status`,
      method: "PATCH",
      payload: { disabled: false },
      permission: "auth:manage",
      permissions,
      ready: disabled,
      reason: "user_already_enabled",
    }),
    resetPassword: actionState({
      href: `${basePath}/password`,
      method: "PATCH",
      permission: "auth:manage",
      permissions,
      ready: user.provider === "local",
      reason: "non_local_user_password_unavailable",
    }),
    updateAccess: actionState({
      href: `${basePath}/access`,
      method: "PATCH",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
  };
}

function accessPolicyActions(permissions: readonly Permission[]) {
  return {
    read: actionState({
      href: "/api/v1/auth/access-policies",
      method: "GET",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
    update: actionState({
      href: "/api/v1/auth/access-policies",
      method: "PATCH",
      permission: "auth:manage",
      permissions,
      ready: true,
    }),
  };
}

function actionState({
  href,
  method,
  payload,
  permission,
  permissions,
  ready,
  reason,
}: {
  href?: string;
  method: AuthActionState["method"];
  payload?: Record<string, unknown>;
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): AuthActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, payload, permission }
    : { enabled: false, method, payload, permission, reason };
}

function authRootLinks() {
  return {
    accessPolicies: "/api/v1/auth/access-policies",
    accessPolicyActions: "/api/v1/auth/access-policies/actions",
    createUser: "/api/v1/auth/users",
    groups: "/api/v1/auth/groups",
    users: "/api/v1/auth/users",
  };
}

function accessPolicyLinks() {
  return {
    actions: "/api/v1/auth/access-policies/actions",
    detail: "/api/v1/auth/access-policies",
    update: "/api/v1/auth/access-policies",
  };
}

function authUserLinks(userId: string) {
  const basePath = `/api/v1/auth/users/${userId}`;

  return {
    access: `${basePath}/access`,
    actions: `${basePath}/actions`,
    delete: basePath,
    detail: basePath,
    password: `${basePath}/password`,
    status: `${basePath}/status`,
  };
}

function disableReason(user: CurrentUser, actor: NonNullable<AuthResult["user"]>) {
  if (user.id === actor.id) {
    return "self_disable_denied";
  }

  if (user.id === localAdminId()) {
    return "local_admin_disable_denied";
  }

  return user.disabledAt ? "user_already_disabled" : undefined;
}

function deleteReason(user: CurrentUser, actor: NonNullable<AuthResult["user"]>) {
  if (user.id === actor.id) {
    return "self_delete_denied";
  }

  if (user.id === localAdminId()) {
    return "local_admin_delete_denied";
  }

  return undefined;
}
