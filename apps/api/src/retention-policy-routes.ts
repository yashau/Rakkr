import type { Context, Hono } from "hono";
import {
  retentionPolicyInputSchema,
  retentionPolicyUpdateSchema,
  type RetentionPolicy,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import {
  createRetentionPolicy,
  findRetentionPolicy,
  listRetentionPolicies,
  updateRetentionPolicy,
} from "./retention-policies.js";
import { retentionPolicySettingsTarget, scopedRetentionPolicies } from "./settings-scope.js";

interface RetentionPolicyRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  hasResourceScope?(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

export function registerRetentionPolicyRoutes({
  app,
  currentAuth,
  hasResourceScope = async () => true,
  recordAuditEvent,
  requirePermission,
}: RetentionPolicyRouteDependencies) {
  app.get(
    "/api/v1/settings/retention-policies",
    requirePermission("settings:read", "settings.retention_policies.read", () => ({
      type: "settings",
    })),
    async (c) => {
      const policies = await scopedRetentionPolicies(
        currentAuth(c).user,
        await listRetentionPolicies(),
        hasResourceScope,
      );

      await recordRetentionPolicyRead(c, {
        action: "settings.retention_policies.read.succeeded",
        currentAuth,
        recordAuditEvent,
        returnedCount: policies.length,
        target: { type: "settings" },
      });

      return c.json({ data: policies });
    },
  );

  app.get(
    "/api/v1/settings/retention-policies/:policyId/actions",
    requirePermission("settings:read", "settings.retention_policies.actions.read", async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await findRetentionPolicy(policyId);

      return policy
        ? retentionPolicySettingsTarget(policy)
        : { id: policyId, type: "retention_policy" };
    }),
    async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await findRetentionPolicy(policyId);

      if (!policy) {
        await recordRetentionPolicyActionRead(c, {
          action: "settings.retention_policies.actions.read.failed",
          currentAuth,
          recordAuditEvent,
          reason: "not_found",
          target: { id: policyId, type: "retention_policy" },
        });

        return c.json({ error: "Retention policy not found" }, 404);
      }

      const actions = retentionPolicyActions(
        currentAuth(c).user?.permissions ?? [],
        `/api/v1/settings/retention-policies/${policy.id}`,
      );

      await recordRetentionPolicyActionRead(c, {
        action: "settings.retention_policies.actions.read.succeeded",
        currentAuth,
        recordAuditEvent,
        target: retentionPolicySettingsTarget(policy),
        visibleActionCount: Object.keys(actions).length,
      });

      return c.json({
        data: {
          actions,
          links: {
            detail: `/api/v1/settings/retention-policies/${policy.id}`,
            update: `/api/v1/settings/retention-policies/${policy.id}`,
          },
          policy,
        },
      });
    },
  );

  app.get(
    "/api/v1/settings/retention-policies/:policyId",
    requirePermission("settings:read", "settings.retention_policies.detail.read", async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await findRetentionPolicy(policyId);

      return policy
        ? retentionPolicySettingsTarget(policy)
        : { id: policyId, type: "retention_policy" };
    }),
    async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await findRetentionPolicy(policyId);

      if (!policy) {
        await recordRetentionPolicyRead(c, {
          action: "settings.retention_policies.detail.read.failed",
          currentAuth,
          recordAuditEvent,
          reason: "not_found",
          target: { id: policyId, type: "retention_policy" },
        });

        return c.json({ error: "Retention policy not found" }, 404);
      }

      await recordRetentionPolicyRead(c, {
        action: "settings.retention_policies.detail.read.succeeded",
        currentAuth,
        recordAuditEvent,
        target: retentionPolicySettingsTarget(policy),
      });

      return c.json({ data: policy });
    },
  );

  app.post(
    "/api/v1/settings/retention-policies",
    requirePermission("settings:manage", "settings.retention_policies.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = retentionPolicyInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(c, "settings.retention_policies.create.failed", {
          details: { reason: "invalid_request" },
          recordAuditEvent,
        });
        return c.json({ error: "Invalid retention policy", issues: body.error.issues }, 400);
      }

      const created = await createRetentionPolicy(body.data);

      await recordAuditEvent(c, {
        action: "settings.retention_policies.create.succeeded",
        after: retentionPolicySnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: retentionPolicySettingsTarget(created),
      });

      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/retention-policies/:policyId",
    requirePermission("settings:manage", "settings.retention_policies.update", async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await findRetentionPolicy(policyId);

      return policy
        ? retentionPolicySettingsTarget(policy)
        : { id: policyId, type: "retention_policy" };
    }),
    async (c) => {
      const policyId = c.req.param("policyId");
      const before = await findRetentionPolicy(policyId);

      if (!before) {
        await recordSettingsFailure(c, "settings.retention_policies.update.failed", {
          details: { reason: "not_found" },
          recordAuditEvent,
          target: { id: policyId, type: "retention_policy" },
        });
        return c.json({ error: "Retention policy not found" }, 404);
      }

      const body = retentionPolicyUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(c, "settings.retention_policies.update.failed", {
          details: { reason: "invalid_request" },
          recordAuditEvent,
          target: retentionPolicySettingsTarget(before),
        });
        return c.json({ error: "Invalid retention policy", issues: body.error.issues }, 400);
      }

      const updated = await updateRetentionPolicy(policyId, body.data);

      if (!updated) {
        await recordSettingsFailure(c, "settings.retention_policies.update.failed", {
          details: { reason: "not_found" },
          recordAuditEvent,
          target: retentionPolicySettingsTarget(before),
        });
        return c.json({ error: "Retention policy not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.retention_policies.update.succeeded",
        after: retentionPolicySnapshot(updated),
        auth: currentAuth(c),
        before: retentionPolicySnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: retentionPolicySettingsTarget(updated),
      });

      return c.json({ data: updated });
    },
  );
}

function retentionPolicyActions(permissions: readonly string[], href: string) {
  return {
    detail: retentionPolicyActionState({
      href,
      method: "GET",
      permission: "settings:read",
      permissions,
    }),
    update: retentionPolicyActionState({
      href,
      method: "PATCH",
      permission: "settings:manage",
      permissions,
    }),
  };
}

function retentionPolicyActionState({
  href,
  method,
  permission,
  permissions,
}: {
  href: string;
  method: "GET" | "PATCH";
  permission: "settings:read" | "settings:manage";
  permissions: readonly string[];
}) {
  return permissions.includes(permission)
    ? { enabled: true, href, method, permission }
    : { enabled: false, method, permission, reason: "missing_permission" };
}

async function recordSettingsFailure(
  c: Context<AppBindings>,
  action: string,
  {
    details,
    recordAuditEvent,
    target = { type: "settings" },
  }: {
    details: { reason: string };
    recordAuditEvent: RecordAuditEvent;
    target?: AuditTarget;
  },
) {
  await recordAuditEvent(c, {
    action,
    details,
    outcome: "failed",
    reason: details.reason,
    target,
  });
}

async function recordRetentionPolicyActionRead(
  c: Context<AppBindings>,
  {
    action,
    currentAuth,
    recordAuditEvent,
    reason,
    target,
    visibleActionCount,
  }: {
    action: string;
    currentAuth: (c: Context<AppBindings>) => AuthResult;
    recordAuditEvent: RecordAuditEvent;
    reason?: string;
    target: AuditTarget;
    visibleActionCount?: number;
  },
) {
  await recordAuditEvent(c, {
    action,
    auth: currentAuth(c),
    details: {
      visibleActionCount,
    },
    outcome: reason ? "failed" : "succeeded",
    permission: "settings:read",
    reason,
    target,
  });
}

async function recordRetentionPolicyRead(
  c: Context<AppBindings>,
  {
    action,
    currentAuth,
    reason,
    recordAuditEvent,
    returnedCount,
    target,
  }: {
    action: string;
    currentAuth: (c: Context<AppBindings>) => AuthResult;
    reason?: string;
    recordAuditEvent: RecordAuditEvent;
    returnedCount?: number;
    target: AuditTarget;
  },
) {
  await recordAuditEvent(c, {
    action,
    auth: currentAuth(c),
    details: {
      returnedCount,
    },
    outcome: reason ? "failed" : "succeeded",
    permission: "settings:read",
    reason,
    target,
  });
}

function retentionPolicySnapshot(policy: RetentionPolicy) {
  return {
    action: policy.action,
    deleteOnlyAfterUploaded: policy.deleteOnlyAfterUploaded,
    enabled: policy.enabled,
    id: policy.id,
    maxAgeDays: policy.maxAgeDays,
    maxBytes: policy.maxBytes,
    minFreeDiskPercent: policy.minFreeDiskPercent,
    name: policy.name,
    preserveTagged: policy.preserveTagged,
    scope: policy.scope,
  };
}
