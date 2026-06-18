import { z } from "zod";
import type { Context, Hono } from "hono";

import { accessSnapshot, localAdminId } from "./auth-utils.js";
import { AuthError, LocalAuthService, type AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";

interface AuthLifecycleRouteDependencies {
  app: Hono<AppBindings>;
  authService: LocalAuthService;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

const passwordResetSchema = z.object({
  password: z.string().min(8).max(200),
});
const userStatusSchema = z.object({
  disabled: z.boolean(),
});

export function registerAuthLifecycleRoutes({
  app,
  authService,
  currentAuth,
  currentUser,
  recordAuditEvent,
  requirePermission,
}: AuthLifecycleRouteDependencies) {
  app.patch(
    "/api/v1/auth/users/:userId/password",
    requirePermission("auth:manage", "auth.users.password.reset", userTarget),
    async (c) => {
      const userId = c.req.param("userId");
      const body = passwordResetSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.password.reset.failed",
          userId,
          "invalid_request",
        );
        return c.json({ error: "Invalid password reset", issues: body.error.issues }, 400);
      }

      const before = await authService.localUser(userId);

      if (!before) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.password.reset.failed",
          userId,
          "user_not_found",
        );
        return c.json({ error: "User not found" }, 404);
      }

      try {
        const updated = await authService.resetLocalUserPassword(userId, body.data.password);

        if (!updated) {
          await recordUserLifecycleFailure(
            c,
            "auth.users.password.reset.failed",
            userId,
            "user_not_found",
            before.email,
          );
          return c.json({ error: "User not found" }, 404);
        }

        await recordAuditEvent(c, {
          action: "auth.users.password.reset.succeeded",
          after: accessSnapshot(updated),
          auth: currentAuth(c),
          before: accessSnapshot(before),
          details: {
            sessionsRevoked: true,
          },
          outcome: "succeeded",
          permission: "auth:manage",
          target: {
            id: updated.id,
            name: updated.email,
            type: "user",
          },
        });

        return c.json({ data: updated });
      } catch (error) {
        return handleLifecycleError(
          c,
          "auth.users.password.reset.failed",
          userId,
          before.email,
          error,
        );
      }
    },
  );

  app.patch(
    "/api/v1/auth/users/:userId/status",
    requirePermission("auth:manage", "auth.users.status.update", userTarget),
    async (c) => {
      const userId = c.req.param("userId");
      const body = userStatusSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.status.update.failed",
          userId,
          "invalid_request",
        );
        return c.json({ error: "Invalid user status", issues: body.error.issues }, 400);
      }

      if (body.data.disabled && userId === currentUser(c).id) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.status.update.failed",
          userId,
          "self_disable_denied",
        );
        return c.json({ error: "Cannot disable the current user" }, 400);
      }

      if (body.data.disabled && userId === localAdminId()) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.status.update.failed",
          userId,
          "local_admin_disable_denied",
        );
        return c.json({ error: "Cannot disable the bootstrap local admin" }, 400);
      }

      const before = await authService.localUser(userId);

      if (!before) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.status.update.failed",
          userId,
          "user_not_found",
        );
        return c.json({ error: "User not found" }, 404);
      }

      try {
        const updated = await authService.updateLocalUserDisabled(userId, body.data.disabled);

        if (!updated) {
          await recordUserLifecycleFailure(
            c,
            "auth.users.status.update.failed",
            userId,
            "user_not_found",
            before.email,
          );
          return c.json({ error: "User not found" }, 404);
        }

        await recordAuditEvent(c, {
          action: "auth.users.status.update.succeeded",
          after: accessSnapshot(updated),
          auth: currentAuth(c),
          before: accessSnapshot(before),
          details: {
            disabled: body.data.disabled,
            sessionsRevoked: body.data.disabled,
          },
          outcome: "succeeded",
          permission: "auth:manage",
          target: {
            id: updated.id,
            name: updated.email,
            type: "user",
          },
        });

        return c.json({ data: updated });
      } catch (error) {
        return handleLifecycleError(
          c,
          "auth.users.status.update.failed",
          userId,
          before.email,
          error,
        );
      }
    },
  );

  app.delete(
    "/api/v1/auth/users/:userId",
    requirePermission("auth:manage", "auth.users.delete", userTarget),
    async (c) => {
      const userId = c.req.param("userId");

      if (userId === currentUser(c).id) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.delete.failed",
          userId,
          "self_delete_denied",
        );
        return c.json({ error: "Cannot delete the current user" }, 400);
      }

      if (userId === localAdminId()) {
        await recordUserLifecycleFailure(
          c,
          "auth.users.delete.failed",
          userId,
          "local_admin_delete_denied",
        );
        return c.json({ error: "Cannot delete the bootstrap local admin" }, 400);
      }

      const before = await authService.localUser(userId);

      if (!before) {
        await recordUserLifecycleFailure(c, "auth.users.delete.failed", userId, "user_not_found");
        return c.json({ error: "User not found" }, 404);
      }

      try {
        const deleted = await authService.deleteLocalUser(userId);

        if (!deleted) {
          await recordUserLifecycleFailure(
            c,
            "auth.users.delete.failed",
            userId,
            "user_not_found",
            before.email,
          );
          return c.json({ error: "User not found" }, 404);
        }

        await recordAuditEvent(c, {
          action: "auth.users.delete.succeeded",
          auth: currentAuth(c),
          before: accessSnapshot(deleted),
          details: {
            email: deleted.email,
            sessionsRevoked: true,
          },
          outcome: "succeeded",
          permission: "auth:manage",
          target: {
            id: deleted.id,
            name: deleted.email,
            type: "user",
          },
        });

        return c.body(null, 204);
      } catch (error) {
        return handleLifecycleError(c, "auth.users.delete.failed", userId, before.email, error);
      }
    },
  );

  function userTarget(c: Context<AppBindings>) {
    return {
      id: c.req.param("userId"),
      type: "user",
    };
  }

  async function handleLifecycleError(
    c: Context<AppBindings>,
    action: string,
    userId: string,
    name: string | undefined,
    error: unknown,
  ) {
    const reason = error instanceof AuthError ? error.code : "unknown_user_lifecycle_error";

    await recordUserLifecycleFailure(c, action, userId, reason, name);
    return c.json({ error: "Local user lifecycle update unavailable" }, 503);
  }

  async function recordUserLifecycleFailure(
    c: Context<AppBindings>,
    action: string,
    userId: string,
    reason: string,
    name?: string,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: "auth:manage",
      reason,
      target: {
        id: userId,
        name,
        type: "user",
      },
    });
  }
}
