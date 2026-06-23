import type { Context, Hono } from "hono";

import type { ChannelMapAssignmentPlanStore } from "./channel-map-assignment-plans.js";
import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { SettingsStore } from "./settings-store.js";
import {
  scopedChannelMapAssignmentPlans,
  scopedChannelMapAssignments,
  scopedChannelMapTemplates,
  scopedRecordingProfiles,
  scopedUploadPolicies,
  scopedUploadProviders,
  scopedWatchdogPolicies,
} from "./settings-scope.js";
import { listUploadPolicies } from "./upload-policies.js";
import type { UploadProviderStore } from "./upload-providers.js";

interface SettingsReadRouteDependencies {
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

export function registerSettingsReadRoutes({
  app,
  channelMapAssignmentPlanStore,
  currentAuth,
  hasResourceScope,
  recordAuditEvent,
  requirePermission,
  settingsStore,
  uploadProviderStore,
}: SettingsReadRouteDependencies) {
  app.get(
    "/api/v1/settings/recording-profiles",
    requirePermission("settings:read", "settings.recording_profiles.read", settingsReadTarget),
    async (c) => {
      const data = await scopedRecordingProfiles(
        currentAuth(c).user,
        settingsStore,
        hasResourceScope,
      );

      await recordSettingsReadSuccess(c, "settings.recording_profiles.read.succeeded", data.length);

      return c.json({ data });
    },
  );

  app.get(
    "/api/v1/settings/watchdog-policies",
    requirePermission("settings:read", "settings.watchdog_policies.read", settingsReadTarget),
    async (c) => {
      const data = await scopedWatchdogPolicies(
        currentAuth(c).user,
        settingsStore,
        hasResourceScope,
      );

      await recordSettingsReadSuccess(c, "settings.watchdog_policies.read.succeeded", data.length);

      return c.json({ data });
    },
  );

  app.get(
    "/api/v1/settings/channel-map-templates",
    requirePermission("settings:read", "settings.channel_map_templates.read", settingsReadTarget),
    async (c) => {
      const data = await scopedChannelMapTemplates(
        currentAuth(c).user,
        settingsStore,
        hasResourceScope,
      );

      await recordSettingsReadSuccess(
        c,
        "settings.channel_map_templates.read.succeeded",
        data.length,
      );

      return c.json({ data });
    },
  );

  app.get(
    "/api/v1/settings/channel-map-assignments",
    requirePermission("settings:read", "settings.channel_map_assignments.read", settingsReadTarget),
    async (c) => {
      const data = await scopedChannelMapAssignments(
        currentAuth(c).user,
        await settingsStore.listChannelMapAssignments(),
        hasResourceScope,
      );

      await recordSettingsReadSuccess(
        c,
        "settings.channel_map_assignments.read.succeeded",
        data.length,
      );

      return c.json({ data });
    },
  );

  app.get(
    "/api/v1/settings/channel-map-assignment-plans",
    requirePermission(
      "settings:read",
      "settings.channel_map_assignment_plans.read",
      settingsReadTarget,
    ),
    async (c) => {
      const data = await scopedChannelMapAssignmentPlans(
        currentAuth(c).user,
        await channelMapAssignmentPlanStore.list(),
        hasResourceScope,
      );

      await recordSettingsReadSuccess(
        c,
        "settings.channel_map_assignment_plans.read.succeeded",
        data.length,
      );

      return c.json({ data });
    },
  );

  app.get(
    "/api/v1/settings/upload-providers",
    requirePermission("settings:read", "settings.upload_providers.read", settingsReadTarget),
    async (c) => {
      const data = await scopedUploadProviders(
        currentAuth(c).user,
        uploadProviderStore,
        hasResourceScope,
      );

      await recordSettingsReadSuccess(c, "settings.upload_providers.read.succeeded", data.length);

      return c.json({ data });
    },
  );

  app.get(
    "/api/v1/settings/upload-policies",
    requirePermission("settings:read", "settings.upload_policies.read", settingsReadTarget),
    async (c) => {
      const data = await scopedUploadPolicies(
        currentAuth(c).user,
        await listUploadPolicies(),
        hasResourceScope,
      );

      await recordSettingsReadSuccess(c, "settings.upload_policies.read.succeeded", data.length);

      return c.json({ data });
    },
  );

  async function recordSettingsReadSuccess(c: Context<AppBindings>, action: string, count: number) {
    await recordAuditEvent(c, {
      action,
      auth: currentAuth(c),
      details: {
        returnedCount: count,
      },
      outcome: "succeeded",
      permission: "settings:read",
      target: settingsReadTarget(),
    });
  }
}

function settingsReadTarget() {
  return { type: "settings" as const };
}
