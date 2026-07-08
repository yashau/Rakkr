import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

import {
  type AuditEvent,
  type Permission,
  permissionRequiresCapability,
  type RoomCapability,
} from "@rakkr/shared";

import type { createAuditStore } from "./audit-store.js";
import type { AuthResult, LocalAuthService } from "./auth-service.js";
import type { AppBindings, AuditTarget, RecordAuditEvent } from "./http-types.js";
import type { createResourceScopeTargets } from "./resource-scope-targets.js";
import type { createRoomRosterStore } from "./room-roster-store.js";

export function requestContext(c: Context<AppBindings>, sessionId?: string) {
  return {
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
    sessionId: sessionId ?? c.req.header("x-rakkr-session-id"),
    userAgent: c.req.header("user-agent"),
  };
}

export function currentAuth(c: Context<AppBindings>) {
  return c.get("auth");
}

export function currentUser(c: Context<AppBindings>) {
  const user = currentAuth(c).user;

  if (!user) {
    throw new Error("Authenticated route reached without a user");
  }

  return user;
}

interface AuthorizationDependencies {
  auditStore: ReturnType<typeof createAuditStore>;
  authService: LocalAuthService;
  resourceScopeTargets: ReturnType<typeof createResourceScopeTargets>;
  roomRosterStore: ReturnType<typeof createRoomRosterStore>;
}

// The audit + authorization closures shared by every route. Extracted from the
// composition root into a factory over the stores it needs so index.ts stays a
// thin wiring file; behavior and the role-scope OR room-capability decision are
// preserved exactly.
export function createAuthorization({
  auditStore,
  authService,
  resourceScopeTargets,
  roomRosterStore,
}: AuthorizationDependencies) {
  const recordAuditEvent: RecordAuditEvent = async (c, input) => {
    const actor =
      input.actor ??
      (input.auth?.user
        ? {
            id: input.auth.user.id,
            name: input.auth.user.name,
            roles: input.auth.user.roles,
            type: "user" as const,
          }
        : {
            id: "anonymous",
            name: "Anonymous",
            roles: [],
            type: "user" as const,
          });
    const event: AuditEvent = {
      action: input.action,
      actor,
      actorContext: requestContext(c, input.auth?.sessionId),
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: {
        method: c.req.method,
        path: c.req.path,
        ...input.details,
      },
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };

  function requirePermission(
    permission: Permission,
    action: string,
    target: (c: Context<AppBindings>) => AuditTarget | Promise<AuditTarget> = () => ({
      type: "controller",
    }),
  ): MiddlewareHandler<AppBindings> {
    return async (c, next) => {
      const auth = await authService.authenticate(c.req.header("authorization"));
      const auditTarget = await target(c);
      const decision = await permissionDecision(auth.user, permission, auditTarget);
      const reason = decision.allowed
        ? undefined
        : authorizationReason({
            authenticated: Boolean(auth.user),
            hasPermission: decision.hasPermission,
            hasScope: decision.scope.allowed,
            scopeReason: decision.scope.reason,
          });

      await recordAuditEvent(c, {
        action,
        auth,
        details: {
          grantedViaRoomCapability: decision.grantedViaRoomCapability,
          requiredPermission: permission,
          resourceScope: auditTarget,
          resourceScopeDecision: decision.scope.reason,
          roomCapability: decision.requiredCapability,
          roles: auth.user?.roles ?? [],
        },
        outcome: decision.allowed ? "allowed" : "denied",
        permission,
        reason,
        target: auditTarget,
      });

      if (!decision.allowed) {
        return c.json(
          {
            error: auth.user ? "Forbidden" : "Unauthorized",
            permission,
          },
          auth.user ? 403 : 401,
        );
      }

      c.set("auth", auth);
      await next();
    };
  }

  // The role-scope OR room-capability allow decision shared by requirePermission and
  // the fine-grained per-room checks in recording/schedule handlers. A room roster
  // (a manual grant or a calendar meeting-assignment) grants a per-action capability
  // over its room even without the role permission — but never past an explicit deny.
  // Exported for test coverage of the access-policy-DENY-beats-roster-grant
  // precedence (the `scope.reason !== "access_policy_denied"` guard below).
  async function permissionDecision(
    user: AuthResult["user"],
    permission: Permission,
    target: AuditTarget,
  ) {
    const hasPermission = user?.permissions.includes(permission) ?? false;
    const scope = user
      ? await resourceScopeDecision(user, target)
      : { allowed: false, reason: "unauthenticated" as const };
    let allowed = hasPermission && scope.allowed;
    let grantedViaRoomCapability = false;
    const requiredCapability = permissionRequiresCapability(permission);

    if (!allowed && user && scope.reason !== "access_policy_denied" && requiredCapability) {
      grantedViaRoomCapability = await roomCapabilityAuthorizes(user, requiredCapability, target);
      allowed = grantedViaRoomCapability;
    }

    return { allowed, grantedViaRoomCapability, hasPermission, requiredCapability, scope };
  }

  // Whether a user is authorized for a permission against a target, reusing the same
  // logic as requirePermission without auditing or an HTTP response. Used for the
  // fine-grained per-room check once a request's room is resolved from its channels.
  async function authorizeTargetForUser(
    user: AuthResult["user"],
    permission: Permission,
    target: AuditTarget,
  ) {
    return (await permissionDecision(user, permission, target)).allowed;
  }

  function authorizationReason(input: {
    authenticated: boolean;
    hasPermission: boolean;
    hasScope: boolean;
    scopeReason?: string;
  }) {
    if (!input.authenticated) {
      return "unauthenticated";
    }

    if (!input.hasPermission) {
      return "missing_permission";
    }

    if (!input.hasScope) {
      return input.scopeReason ?? "missing_resource_scope";
    }

    return undefined;
  }

  async function hasResourceScope(user: AuthResult["user"], target: AuditTarget) {
    return (await resourceScopeDecision(user, target)).allowed;
  }

  async function resourceScopeDecision(user: AuthResult["user"], target: AuditTarget) {
    if (!user || !target.id) {
      return {
        allowed: Boolean(user),
        reason: user ? undefined : "unauthenticated",
      };
    }

    const targets = await resourceScopeTargets(target);
    const policyDecision = await authService.accessPolicyDecision(user, targets);

    if (policyDecision?.effect === "deny") {
      return {
        allowed: false,
        reason: "access_policy_denied",
      };
    }

    if (user.roles.includes("owner") || user.roles.includes("admin")) {
      return {
        allowed: true,
        reason: undefined,
      };
    }

    if (policyDecision?.effect === "allow") {
      return {
        allowed: true,
        reason: undefined,
      };
    }

    const allowedByGrant = targets.some((candidate) =>
      user.resourceGrants.some(
        (grant) =>
          (grant.resourceType === candidate.type || grant.resourceType === "*") &&
          (grant.resourceId === candidate.id || grant.resourceId === "*"),
      ),
    );

    return {
      allowed: allowedByGrant,
      reason: allowedByGrant ? undefined : "missing_resource_scope",
    };
  }

  function rosterSubject(user: NonNullable<AuthResult["user"]>) {
    return { groupIds: user.groups.map((group) => group.id), userId: user.id };
  }

  // Room ids a target resolves into (via the shared hierarchy expansion).
  function roomIdsFromTargets(targets: AuditTarget[]) {
    const roomIds: string[] = [];

    for (const target of targets) {
      if (target.type === "room" && target.id) {
        roomIds.push(target.id);
      }
    }

    return roomIds;
  }

  // The set of room ids the user holds any capability in (direct or via a group).
  async function rosterRoomIds(user: NonNullable<AuthResult["user"]>) {
    return new Set((await roomRosterStore.roomsForSubject(rosterSubject(user))).keys());
  }

  // True when the user holds `capability` in a room that `target` resolves into,
  // via the room roster (a manual grant or a calendar meeting-assignment). Reuses
  // the same hierarchy expansion as role scoping, so a room grant covers that
  // room's nodes, interfaces, channels, schedules, and recordings.
  async function roomCapabilityAuthorizes(
    user: NonNullable<AuthResult["user"]>,
    capability: RoomCapability,
    target: AuditTarget,
  ) {
    if (!target.id) {
      return false;
    }

    const roomIds = roomIdsFromTargets(await resourceScopeTargets(target));

    if (roomIds.length === 0) {
      return false;
    }

    const subject = rosterSubject(user);

    for (const roomId of roomIds) {
      const capabilities = await roomRosterStore.effectiveCapabilities(subject, roomId);

      if (capabilities.has(capability)) {
        return true;
      }
    }

    return false;
  }

  return {
    authorizeTargetForUser,
    hasResourceScope,
    permissionDecision,
    recordAuditEvent,
    requirePermission,
    rosterRoomIds,
  };
}
