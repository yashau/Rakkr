import type { Context, Hono } from "hono";
import {
  recordingProfileUpdateSchema,
  recordingProfileWritableSchema,
  watchdogPolicyUpdateSchema,
  watchdogPolicyWritableSchema,
  type RecordingProfile,
  type WatchdogPolicy,
} from "@rakkr/shared";

import {
  createChannelMapAssignmentPlanStore,
  type ChannelMapAssignmentPlanStore,
} from "./channel-map-assignment-plans.js";
import {
  createControllerSettingsStore,
  type ControllerSettingsStore,
} from "./controller-settings-store.js";
import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { SettingsStore } from "./settings-store.js";
import {
  createUploadDestinationStore,
  type UploadDestinationStore,
} from "./upload-destinations.js";
import { registerSettingsActionRoutes } from "./settings-action-routes.js";
import { registerSettingsChannelMapRoutes } from "./settings-channel-map-routes.js";
import { registerSettingsControllerRoutes } from "./settings-controller-routes.js";
import { registerSettingsDetailRoutes } from "./settings-detail-routes.js";
import { registerSettingsReadRoutes } from "./settings-read-routes.js";
import { registerSettingsUploadDestinationRoutes } from "./settings-upload-destination-routes.js";
import { registerSettingsUploadPolicyRoutes } from "./settings-upload-policy-routes.js";
import { profileSettingsTarget, watchdogSettingsTarget } from "./settings-scope.js";

// Create bodies require only a name; the store fills the rest from the built-in
// template. Derive from the same bounded writable schema the PATCH routes use so
// create enforces identical input ceilings (a create off the permissive base
// schema would accept an over-varchar(160) name and 500/latch on insert).
const recordingProfileCreateSchema = recordingProfileWritableSchema.required({ name: true });
const watchdogPolicyCreateSchema = watchdogPolicyWritableSchema.required({ name: true });

interface SettingsRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  hasResourceScope?(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
  channelMapAssignmentPlanStore?: ChannelMapAssignmentPlanStore;
  controllerSettingsStore?: ControllerSettingsStore;
  uploadDestinationStore?: UploadDestinationStore;
}

export function registerSettingsRoutes({
  app,
  currentAuth,
  channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore(),
  controllerSettingsStore = createControllerSettingsStore(),
  hasResourceScope = async () => true,
  recordAuditEvent,
  requirePermission,
  settingsStore,
  uploadDestinationStore = createUploadDestinationStore(),
}: SettingsRouteDependencies) {
  registerSettingsControllerRoutes({
    app,
    controllerSettingsStore,
    currentAuth,
    recordAuditEvent,
    requirePermission,
  });
  registerSettingsReadRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentAuth,
    hasResourceScope,
    recordAuditEvent,
    requirePermission,
    settingsStore,
    uploadDestinationStore,
  });
  registerSettingsDetailRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentAuth,
    hasResourceScope,
    recordAuditEvent,
    requirePermission,
    settingsStore,
    uploadDestinationStore,
  });
  registerSettingsActionRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentAuth,
    hasResourceScope,
    recordAuditEvent,
    requirePermission,
    settingsStore,
    uploadDestinationStore,
  });
  registerSettingsUploadPolicyRoutes({
    app,
    currentAuth,
    hasResourceScope,
    recordAuditEvent,
    requirePermission,
    uploadDestinationStore,
  });
  registerSettingsUploadDestinationRoutes({
    app,
    currentAuth,
    recordAuditEvent,
    requirePermission,
    uploadDestinationStore,
  });
  registerSettingsChannelMapRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentAuth,
    hasResourceScope,
    recordAuditEvent,
    requirePermission,
    settingsStore,
  });

  app.post(
    "/api/v1/settings/recording-profiles",
    requirePermission("settings:manage", "settings.recording_profiles.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = recordingProfileCreateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.recording_profiles.create.failed",
          "invalid_request",
        );
        return c.json({ error: "Invalid recording profile", issues: body.error.issues }, 400);
      }

      const created = await settingsStore.createRecordingProfile(body.data);

      await recordAuditEvent(c, {
        action: "settings.recording_profiles.create.succeeded",
        after: profileSnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: profileSettingsTarget(created),
      });
      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/recording-profiles/:profileId",
    requirePermission("settings:manage", "settings.recording_profiles.update", async (c) => {
      const profileId = c.req.param("profileId") ?? "";
      const profile = await settingsStore.findRecordingProfile(profileId);

      return profile
        ? profileSettingsTarget(profile)
        : { id: profileId, type: "recording_profile" };
    }),
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
          profileSettingsTarget(before),
        );
        return c.json({ error: "Invalid recording profile", issues: body.error.issues }, 400);
      }

      const updated = await settingsStore.updateRecordingProfile(profileId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.recording_profiles.update.failed",
          "not_found",
          profileSettingsTarget(before),
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
        target: profileSettingsTarget(updated),
      });

      return c.json({ data: updated });
    },
  );

  app.post(
    "/api/v1/settings/watchdog-policies",
    requirePermission("settings:manage", "settings.watchdog_policies.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = watchdogPolicyCreateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.watchdog_policies.create.failed",
          "invalid_request",
        );
        return c.json({ error: "Invalid watchdog policy", issues: body.error.issues }, 400);
      }

      const created = await settingsStore.createWatchdogPolicy(body.data);

      await recordAuditEvent(c, {
        action: "settings.watchdog_policies.create.succeeded",
        after: watchdogSnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: watchdogSettingsTarget(created),
      });
      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/watchdog-policies/:policyId",
    requirePermission("settings:manage", "settings.watchdog_policies.update", async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await settingsStore.findWatchdogPolicy(policyId);

      return policy ? watchdogSettingsTarget(policy) : { id: policyId, type: "watchdog_policy" };
    }),
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
          watchdogSettingsTarget(before),
        );
        return c.json({ error: "Invalid watchdog policy", issues: body.error.issues }, 400);
      }

      const updated = await settingsStore.updateWatchdogPolicy(policyId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.watchdog_policies.update.failed",
          "not_found",
          watchdogSettingsTarget(before),
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
        target: watchdogSettingsTarget(updated),
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

function profileSnapshot(profile: RecordingProfile) {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    codec: profile.codec,
    id: profile.id,
    maxTrackSeconds: profile.maxTrackSeconds,
    name: profile.name,
    silenceDetectionEnabled: profile.silenceDetectionEnabled,
    silenceSkipEnabled: profile.silenceSkipEnabled,
    vbr: profile.vbr,
  };
}

function watchdogSnapshot(policy: WatchdogPolicy) {
  return {
    activeDuring: policy.activeDuring,
    broadbandNoiseScoreThreshold: policy.broadbandNoiseScoreThreshold,
    channelCorrelationMode: policy.channelCorrelationMode ?? "off",
    channelCorrelationThreshold: policy.channelCorrelationThreshold,
    clippingMode: policy.clippingMode ?? "off",
    flatlineMode: policy.flatlineMode ?? "off",
    flatlineThresholdDbfs: policy.flatlineThresholdDbfs,
    graceSeconds: policy.graceSeconds,
    humScoreThreshold: policy.humScoreThreshold,
    id: policy.id,
    metric: policy.metric,
    minCumulativeChannelCorrelationSeconds: policy.minCumulativeChannelCorrelationSeconds,
    minCumulativeClippingSeconds: policy.minCumulativeClippingSeconds,
    minCumulativeFlatlineSeconds: policy.minCumulativeFlatlineSeconds,
    minCumulativeQualitySeconds: policy.minCumulativeQualitySeconds,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    minCumulativeSpeechSeconds: policy.minCumulativeSpeechSeconds,
    minSpeechScore: policy.minSpeechScore,
    name: policy.name,
    noiseScoreThreshold: policy.noiseScoreThreshold,
    qualityAlertMode: policy.qualityAlertMode ?? "off",
    qualityMode: policy.qualityMode ?? "signal_only",
    repeatEverySeconds: policy.repeatEverySeconds,
    severity: policy.severity,
    staticScoreThreshold: policy.staticScoreThreshold,
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
  };
}
