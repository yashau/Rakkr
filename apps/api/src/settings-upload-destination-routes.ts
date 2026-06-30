import type { Context, Hono } from "hono";
import {
  uploadDestinationInputSchema,
  uploadDestinationUpdateSchema,
  type UploadDestinationRuntimeStatus,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import { uploadDestinationSettingsTarget } from "./settings-scope.js";
import type { UploadDestinationStore } from "./upload-destinations.js";

interface SettingsUploadDestinationRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  uploadDestinationStore: UploadDestinationStore;
}

export function registerSettingsUploadDestinationRoutes({
  app,
  currentAuth,
  recordAuditEvent,
  requirePermission,
  uploadDestinationStore,
}: SettingsUploadDestinationRouteDependencies) {
  app.post(
    "/api/v1/settings/upload-destinations",
    requirePermission("settings:manage", "settings.upload_destinations.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = uploadDestinationInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.upload_destinations.create.failed",
          "invalid_request",
        );
        return c.json({ error: "Invalid upload destination", issues: body.error.issues }, 400);
      }

      const created = await uploadDestinationStore.create(body.data);

      await recordAuditEvent(c, {
        action: "settings.upload_destinations.create.succeeded",
        after: uploadDestinationSnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadDestinationSettingsTarget(created),
      });

      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/upload-destinations/:id",
    requirePermission("settings:manage", "settings.upload_destinations.update", async (c) => {
      const id = c.req.param("id") ?? "";
      const destination = await uploadDestinationStore.find(id);

      return destination
        ? uploadDestinationSettingsTarget(destination)
        : { id, type: "upload_destination" };
    }),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const before = await uploadDestinationStore.find(id);

      if (!before) {
        await recordSettingsFailure(c, "settings.upload_destinations.update.failed", "not_found", {
          id,
          type: "upload_destination",
        });
        return c.json({ error: "Upload destination not found" }, 404);
      }

      const body = uploadDestinationUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.upload_destinations.update.failed",
          "invalid_request",
          uploadDestinationSettingsTarget(before),
        );
        return c.json({ error: "Invalid upload destination", issues: body.error.issues }, 400);
      }

      const updated = await uploadDestinationStore.update(id, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.upload_destinations.update.failed",
          "not_found",
          uploadDestinationSettingsTarget(before),
        );
        return c.json({ error: "Upload destination not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.upload_destinations.update.succeeded",
        after: uploadDestinationSnapshot(updated),
        auth: currentAuth(c),
        before: uploadDestinationSnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadDestinationSettingsTarget(updated),
      });

      return c.json({ data: updated });
    },
  );

  app.delete(
    "/api/v1/settings/upload-destinations/:id",
    requirePermission("settings:manage", "settings.upload_destinations.delete", async (c) => {
      const id = c.req.param("id") ?? "";
      const destination = await uploadDestinationStore.find(id);

      return destination
        ? uploadDestinationSettingsTarget(destination)
        : { id, type: "upload_destination" };
    }),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const before = await uploadDestinationStore.find(id);

      if (!before) {
        await recordSettingsFailure(c, "settings.upload_destinations.delete.failed", "not_found", {
          id,
          type: "upload_destination",
        });
        return c.json({ error: "Upload destination not found" }, 404);
      }

      await uploadDestinationStore.delete(id);

      await recordAuditEvent(c, {
        action: "settings.upload_destinations.delete.succeeded",
        auth: currentAuth(c),
        before: uploadDestinationSnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadDestinationSettingsTarget(before),
      });

      return c.json({ data: { id } });
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

// Built from the masked runtime status: the non-secret smb/s3 config plus
// hasSmbPassword/hasS3SecretAccessKey indicators. Secret values are never present.
function uploadDestinationSnapshot(destination: UploadDestinationRuntimeStatus) {
  return {
    configured: destination.configured,
    displayName: destination.displayName,
    enabled: destination.enabled,
    hasS3SecretAccessKey: destination.hasS3SecretAccessKey,
    hasSmbPassword: destination.hasSmbPassword,
    id: destination.id,
    implemented: destination.implemented,
    kind: destination.kind,
    missingFields: destination.missingFields,
    s3: destination.s3,
    smb: destination.smb,
    status: destination.status,
    target: destination.target,
  };
}
