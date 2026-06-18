import type { Context, Hono } from "hono";
import { recordingProfileUpdateSchema, type RecordingProfile } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { SettingsStore } from "./settings-store.js";

interface SettingsRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
}

export function registerSettingsRoutes({
  app,
  currentAuth,
  recordAuditEvent,
  requirePermission,
  settingsStore,
}: SettingsRouteDependencies) {
  app.get(
    "/api/v1/settings/recording-profiles",
    requirePermission("settings:read", "settings.recording_profiles.read", () => ({
      type: "settings",
    })),
    async (c) => c.json({ data: await settingsStore.listRecordingProfiles() }),
  );

  app.patch(
    "/api/v1/settings/recording-profiles/:profileId",
    requirePermission("settings:manage", "settings.recording_profiles.update", () => ({
      type: "settings",
    })),
    async (c) => {
      const profileId = c.req.param("profileId");
      const before = await settingsStore.findRecordingProfile(profileId);

      if (!before) {
        await recordSettingsFailure(c, "settings.recording_profiles.update.failed", "not_found", {
          id: profileId,
          type: "recording_profile",
        });
        return c.json({ error: "Recording profile not found" }, 404);
      }

      const body = recordingProfileUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.recording_profiles.update.failed",
          "invalid_request",
          profileAuditTarget(before),
        );
        return c.json({ error: "Invalid recording profile", issues: body.error.issues }, 400);
      }

      const updated = await settingsStore.updateRecordingProfile(profileId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.recording_profiles.update.failed",
          "not_found",
          profileAuditTarget(before),
        );
        return c.json({ error: "Recording profile not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.recording_profiles.update.succeeded",
        after: profileSnapshot(updated),
        auth: currentAuth(c),
        before: profileSnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: profileAuditTarget(updated),
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

function profileAuditTarget(profile: RecordingProfile) {
  return {
    id: profile.id,
    name: profile.name,
    type: "recording_profile",
  };
}

function profileSnapshot(profile: RecordingProfile) {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    codec: profile.codec,
    id: profile.id,
    name: profile.name,
    silenceDetectionEnabled: profile.silenceDetectionEnabled,
    silenceSkipEnabled: profile.silenceSkipEnabled,
    vbr: profile.vbr,
  };
}
