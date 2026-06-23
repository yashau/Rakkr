import type { Context, Hono } from "hono";
import { uploadProviderSchema } from "@rakkr/shared";

import type { ChannelMapAssignmentPlanStore } from "./channel-map-assignment-plans.js";
import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import {
  channelMapTemplateSettingsTarget,
  firstHiddenChannelMapAssignmentTarget,
  profileSettingsTarget,
  uploadPolicySettingsTarget,
  uploadProviderSettingsTarget,
  watchdogSettingsTarget,
} from "./settings-scope.js";
import type { SettingsStore } from "./settings-store.js";
import { findUploadPolicy } from "./upload-policies.js";
import type { UploadProviderStore } from "./upload-providers.js";

interface SettingsDetailRouteDependencies {
  app: Hono<AppBindings>;
  channelMapAssignmentPlanStore: ChannelMapAssignmentPlanStore;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
  uploadProviderStore: UploadProviderStore;
}

export function registerSettingsDetailRoutes({
  app,
  channelMapAssignmentPlanStore,
  currentAuth,
  hasResourceScope,
  recordAuditEvent,
  requirePermission,
  settingsStore,
  uploadProviderStore,
}: SettingsDetailRouteDependencies) {
  app.get(
    "/api/v1/settings/recording-profiles/:profileId",
    requirePermission("settings:read", "settings.recording_profiles.detail.read", async (c) => {
      const profileId = c.req.param("profileId") ?? "";
      const profile = await settingsStore.findRecordingProfile(profileId);

      return profile
        ? profileSettingsTarget(profile)
        : { id: profileId, type: "recording_profile" };
    }),
    async (c) => {
      const profileId = c.req.param("profileId");
      const profile = await settingsStore.findRecordingProfile(profileId);

      if (!profile) {
        await recordSettingsDetailFailure(c, "settings.recording_profiles.detail.read.failed", {
          id: profileId,
          type: "recording_profile",
        });
        return c.json({ error: "Recording profile not found" }, 404);
      }

      await recordSettingsDetailSuccess(
        c,
        "settings.recording_profiles.detail.read.succeeded",
        profileSettingsTarget(profile),
      );

      return c.json({ data: profile });
    },
  );

  app.get(
    "/api/v1/settings/watchdog-policies/:policyId",
    requirePermission("settings:read", "settings.watchdog_policies.detail.read", async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await settingsStore.findWatchdogPolicy(policyId);

      return policy ? watchdogSettingsTarget(policy) : { id: policyId, type: "watchdog_policy" };
    }),
    async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await settingsStore.findWatchdogPolicy(policyId);

      if (!policy) {
        await recordSettingsDetailFailure(c, "settings.watchdog_policies.detail.read.failed", {
          id: policyId,
          type: "watchdog_policy",
        });
        return c.json({ error: "Watchdog policy not found" }, 404);
      }

      await recordSettingsDetailSuccess(
        c,
        "settings.watchdog_policies.detail.read.succeeded",
        watchdogSettingsTarget(policy),
      );

      return c.json({ data: policy });
    },
  );

  app.get(
    "/api/v1/settings/channel-map-templates/:templateId",
    requirePermission("settings:read", "settings.channel_map_templates.detail.read", async (c) => {
      const templateId = c.req.param("templateId") ?? "";
      const template = await settingsStore.findChannelMapTemplate(templateId);

      return template
        ? channelMapTemplateSettingsTarget(template)
        : { id: templateId, type: "channel_map_template" };
    }),
    async (c) => {
      const templateId = c.req.param("templateId");
      const template = await settingsStore.findChannelMapTemplate(templateId);

      if (!template) {
        await recordSettingsDetailFailure(c, "settings.channel_map_templates.detail.read.failed", {
          id: templateId,
          type: "channel_map_template",
        });
        return c.json({ error: "Channel map template not found" }, 404);
      }

      await recordSettingsDetailSuccess(
        c,
        "settings.channel_map_templates.detail.read.succeeded",
        channelMapTemplateSettingsTarget(template),
      );

      return c.json({ data: template });
    },
  );

  app.get(
    "/api/v1/settings/channel-map-assignment-plans/:planId",
    requirePermission(
      "settings:read",
      "settings.channel_map_assignment_plans.detail.read",
      async (c) => {
        const planId = c.req.param("planId") ?? "";
        const plan = await channelMapAssignmentPlanStore.find(planId);
        const hiddenTarget = plan
          ? await firstHiddenChannelMapAssignmentTarget(
              currentAuth(c).user,
              plan.targets,
              hasResourceScope,
            )
          : undefined;

        return hiddenTarget ?? (plan ? planTarget(plan) : planTarget({ id: planId }));
      },
    ),
    async (c) => {
      const planId = c.req.param("planId") ?? "";
      const plan = await channelMapAssignmentPlanStore.find(planId);

      if (!plan) {
        await recordSettingsDetailFailure(
          c,
          "settings.channel_map_assignment_plans.detail.read.failed",
          {
            id: planId,
            type: "channel_map_assignment_plan",
          },
        );
        return c.json({ error: "Channel map assignment plan not found" }, 404);
      }

      await recordSettingsDetailSuccess(
        c,
        "settings.channel_map_assignment_plans.detail.read.succeeded",
        planTarget(plan),
      );

      return c.json({ data: plan });
    },
  );

  app.get(
    "/api/v1/settings/upload-providers/:provider",
    requirePermission("settings:read", "settings.upload_providers.detail.read", async (c) => {
      const provider = uploadProviderSchema.safeParse(c.req.param("provider"));

      return provider.success
        ? uploadProviderSettingsTarget(await uploadProviderStore.findStatus(provider.data))
        : { id: c.req.param("provider"), type: "upload_provider" };
    }),
    async (c) => {
      const provider = uploadProviderSchema.safeParse(c.req.param("provider"));

      if (!provider.success) {
        await recordSettingsDetailFailure(c, "settings.upload_providers.detail.read.failed", {
          id: c.req.param("provider"),
          type: "upload_provider",
        });
        return c.json({ error: "Upload provider not found" }, 404);
      }

      const status = await uploadProviderStore.findStatus(provider.data);

      if (!status) {
        await recordSettingsDetailFailure(c, "settings.upload_providers.detail.read.failed", {
          id: provider.data,
          type: "upload_provider",
        });
        return c.json({ error: "Upload provider not found" }, 404);
      }

      await recordSettingsDetailSuccess(
        c,
        "settings.upload_providers.detail.read.succeeded",
        uploadProviderSettingsTarget(status),
      );

      return c.json({ data: status });
    },
  );

  app.get(
    "/api/v1/settings/upload-policies/:policyId",
    requirePermission("settings:read", "settings.upload_policies.detail.read", async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await findUploadPolicy(policyId);

      return policy ? uploadPolicySettingsTarget(policy) : { id: policyId, type: "upload_policy" };
    }),
    async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await findUploadPolicy(policyId);

      if (!policy) {
        await recordSettingsDetailFailure(c, "settings.upload_policies.detail.read.failed", {
          id: policyId,
          type: "upload_policy",
        });
        return c.json({ error: "Upload policy not found" }, 404);
      }

      await recordSettingsDetailSuccess(
        c,
        "settings.upload_policies.detail.read.succeeded",
        uploadPolicySettingsTarget(policy),
      );

      return c.json({ data: policy });
    },
  );

  async function recordSettingsDetailSuccess(
    c: Context<AppBindings>,
    action: string,
    target: AuditTarget,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "succeeded",
      permission: "settings:read",
      target,
    });
  }

  async function recordSettingsDetailFailure(
    c: Context<AppBindings>,
    action: string,
    target: AuditTarget,
  ) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      outcome: "failed",
      permission: "settings:read",
      reason: "not_found",
      target,
    });
  }
}

function planTarget(plan: { id: string; templateId?: string }): AuditTarget {
  return { id: plan.id, name: plan.templateId, type: "channel_map_assignment_plan" };
}
