import type { Context, Hono } from "hono";
import {
  uploadPolicyInputSchema,
  uploadPolicyUpdateSchema,
  type UploadPolicy,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import { createUploadPolicy, findUploadPolicy, updateUploadPolicy } from "./upload-policies.js";
import { uploadDestinationSettingsTarget, uploadPolicySettingsTarget } from "./settings-scope.js";
import type { UploadDestinationStore } from "./upload-destinations.js";

interface SettingsUploadPolicyRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  hasResourceScope(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  uploadDestinationStore: UploadDestinationStore;
}

export function registerSettingsUploadPolicyRoutes({
  app,
  currentAuth,
  hasResourceScope,
  recordAuditEvent,
  requirePermission,
  uploadDestinationStore,
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

      const destinationDenied = await destinationReferenceFailure(
        c,
        body.data.destinationId,
        "settings.upload_policies.create.failed",
      );

      if (destinationDenied) {
        return destinationDenied;
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

      const destinationDenied = await destinationReferenceFailure(
        c,
        body.data.destinationId,
        "settings.upload_policies.update.failed",
      );

      if (destinationDenied) {
        return destinationDenied;
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

  // Reject a policy that references an upload destination the caller cannot see,
  // or one that does not exist. Destinations are resource-scoped, but a policy's
  // `destinationId` is a body-supplied foreign key — without this check a caller
  // could bind a policy to a scoped-out destination and route recordings to it
  // (recording-create scopes the policy itself, not the policy's destination).
  async function destinationReferenceFailure(
    c: Context<AppBindings>,
    destinationId: string | undefined,
    action: string,
  ): Promise<Response | undefined> {
    if (!destinationId) {
      return undefined;
    }

    const destination = await uploadDestinationStore.find(destinationId);

    if (!destination) {
      await recordSettingsFailure(c, action, "destination_not_found", {
        id: destinationId,
        type: "upload_destination",
      });
      return c.json({ error: "Unknown upload destination" }, 400);
    }

    const user = currentAuth(c).user;
    const target = uploadDestinationSettingsTarget(destination);

    if (user && !(await hasResourceScope(user, target))) {
      await recordSettingsFailure(c, action, "missing_resource_scope", target);
      return c.json({ error: "Forbidden", permission: "settings:manage" }, 403);
    }

    return undefined;
  }

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
