import type { Hono } from "hono";
import { uploadProviderSchema } from "@rakkr/shared";

import type { ChannelMapAssignmentPlanStore } from "./channel-map-assignment-plans.js";
import type { AppBindings, RequirePermission } from "./http-types.js";
import {
  channelMapTemplateSettingsTarget,
  profileSettingsTarget,
  uploadProviderSettingsTarget,
  watchdogSettingsTarget,
} from "./settings-scope.js";
import type { SettingsStore } from "./settings-store.js";
import { listUploadPolicies } from "./upload-policies.js";
import type { UploadProviderStore } from "./upload-providers.js";

interface SettingsDetailRouteDependencies {
  app: Hono<AppBindings>;
  channelMapAssignmentPlanStore: ChannelMapAssignmentPlanStore;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
  uploadProviderStore: UploadProviderStore;
}

export function registerSettingsDetailRoutes({
  app,
  channelMapAssignmentPlanStore,
  requirePermission,
  settingsStore,
  uploadProviderStore,
}: SettingsDetailRouteDependencies) {
  const settingsRead = (action: string) =>
    requirePermission("settings:read", action, () => ({ type: "settings" }));

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
      const profile = await settingsStore.findRecordingProfile(c.req.param("profileId"));

      return profile
        ? c.json({ data: profile })
        : c.json({ error: "Recording profile not found" }, 404);
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
      const policy = await settingsStore.findWatchdogPolicy(c.req.param("policyId"));

      return policy
        ? c.json({ data: policy })
        : c.json({ error: "Watchdog policy not found" }, 404);
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
      const template = await settingsStore.findChannelMapTemplate(c.req.param("templateId"));

      return template
        ? c.json({ data: template })
        : c.json({ error: "Channel map template not found" }, 404);
    },
  );

  app.get(
    "/api/v1/settings/channel-map-assignment-plans/:planId",
    settingsRead("settings.channel_map_assignment_plans.detail.read"),
    async (c) => {
      const plan = await channelMapAssignmentPlanStore.find(c.req.param("planId"));

      return plan
        ? c.json({ data: plan })
        : c.json({ error: "Channel map assignment plan not found" }, 404);
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
        return c.json({ error: "Upload provider not found" }, 404);
      }

      const status = await uploadProviderStore.findStatus(provider.data);

      return status
        ? c.json({ data: status })
        : c.json({ error: "Upload provider not found" }, 404);
    },
  );

  app.get(
    "/api/v1/settings/upload-policies/:policyId",
    settingsRead("settings.upload_policies.detail.read"),
    async (c) => {
      const policyId = c.req.param("policyId");
      const policy = (await listUploadPolicies()).find((candidate) => candidate.id === policyId);

      return policy ? c.json({ data: policy }) : c.json({ error: "Upload policy not found" }, 404);
    },
  );
}
