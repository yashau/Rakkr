import type { Context, Hono } from "hono";
import {
  recordingProfileUpdateSchema,
  watchdogPolicyUpdateSchema,
  type RecordingProfile,
  type WatchdogPolicy,
} from "@rakkr/shared";

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

  app.get(
    "/api/v1/settings/watchdog-policies",
    requirePermission("settings:read", "settings.watchdog_policies.read", () => ({
      type: "settings",
    })),
    async (c) => c.json({ data: await settingsStore.listWatchdogPolicies() }),
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

  app.patch(
    "/api/v1/settings/watchdog-policies/:policyId",
    requirePermission("settings:manage", "settings.watchdog_policies.update", () => ({
      type: "settings",
    })),
    async (c) => {
      const policyId = c.req.param("policyId");
      const before = await settingsStore.findWatchdogPolicy(policyId);

      if (!before) {
        await recordSettingsFailure(c, "settings.watchdog_policies.update.failed", "not_found", {
          id: policyId,
          type: "watchdog_policy",
        });
        return c.json({ error: "Watchdog policy not found" }, 404);
      }

      const body = watchdogPolicyUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.watchdog_policies.update.failed",
          "invalid_request",
          watchdogAuditTarget(before),
        );
        return c.json({ error: "Invalid watchdog policy", issues: body.error.issues }, 400);
      }

      const updated = await settingsStore.updateWatchdogPolicy(policyId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.watchdog_policies.update.failed",
          "not_found",
          watchdogAuditTarget(before),
        );
        return c.json({ error: "Watchdog policy not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.watchdog_policies.update.succeeded",
        after: watchdogSnapshot(updated),
        auth: currentAuth(c),
        before: watchdogSnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: watchdogAuditTarget(updated),
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

function watchdogAuditTarget(policy: WatchdogPolicy) {
  return {
    id: policy.id,
    name: policy.name,
    type: "watchdog_policy",
  };
}

function watchdogSnapshot(policy: WatchdogPolicy) {
  return {
    activeDuring: policy.activeDuring,
    graceSeconds: policy.graceSeconds,
    id: policy.id,
    metric: policy.metric,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    name: policy.name,
    repeatEverySeconds: policy.repeatEverySeconds,
    severity: policy.severity,
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
  };
}
