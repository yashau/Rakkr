import type { Context, Hono } from "hono";
import {
  uploadPolicyInputSchema,
  uploadPolicyUpdateSchema,
  type UploadPolicy,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import { createUploadPolicy, findUploadPolicy, updateUploadPolicy } from "./upload-policies.js";
import { uploadPolicySettingsTarget } from "./settings-scope.js";

interface SettingsUploadPolicyRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
}

export function registerSettingsUploadPolicyRoutes({
  app,
  currentAuth,
  recordAuditEvent,
  requirePermission,
}: SettingsUploadPolicyRouteDependencies) {
  app.post(
    "/api/v1/settings/upload-policies",
    requirePermission("settings:manage", "settings.upload_policies.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = uploadPolicyInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(c, "settings.upload_policies.create.failed", "invalid_request");
        return c.json({ error: "Invalid upload policy", issues: body.error.issues }, 400);
      }

      const created = await createUploadPolicy(body.data);

      await recordAuditEvent(c, {
        action: "settings.upload_policies.create.succeeded",
        after: uploadPolicySnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadPolicySettingsTarget(created),
      });

      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/upload-policies/:policyId",
    requirePermission("settings:manage", "settings.upload_policies.update", async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await findUploadPolicy(policyId);

      return policy ? uploadPolicySettingsTarget(policy) : { id: policyId, type: "upload_policy" };
    }),
    async (c) => {
      const policyId = c.req.param("policyId");
      const before = await findUploadPolicy(policyId);

      if (!before) {
        await recordSettingsFailure(c, "settings.upload_policies.update.failed", "not_found", {
          id: policyId,
          type: "upload_policy",
        });
        return c.json({ error: "Upload policy not found" }, 404);
      }

      const body = uploadPolicyUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.upload_policies.update.failed",
          "invalid_request",
          uploadPolicySettingsTarget(before),
        );
        return c.json({ error: "Invalid upload policy", issues: body.error.issues }, 400);
      }

      const updated = await updateUploadPolicy(policyId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.upload_policies.update.failed",
          "not_found",
          uploadPolicySettingsTarget(before),
        );
        return c.json({ error: "Upload policy not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.upload_policies.update.succeeded",
        after: uploadPolicySnapshot(updated),
        auth: currentAuth(c),
        before: uploadPolicySnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadPolicySettingsTarget(updated),
      });

      return c.json({ data: updated });
    },
  );

  async function recordSettingsFailure(
    c: Context<AppBindings>,
    action: string,
    reason: string,
    target: { id?: string; name?: string; type: string } = { type: "settings" },
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission: "settings:manage",
      reason,
      target,
    });
  }
}

function uploadPolicySnapshot(policy: UploadPolicy) {
  return {
    deleteCacheAfterUpload: policy.deleteCacheAfterUpload,
    destinationId: policy.destinationId,
    enabled: policy.enabled,
    id: policy.id,
    maxAttempts: policy.maxAttempts,
    name: policy.name,
    pathOverride: policy.pathOverride,
    trigger: policy.trigger,
  };
}
