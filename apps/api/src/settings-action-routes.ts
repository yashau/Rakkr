import type { Context, Hono } from "hono";
import type {
  ChannelMapAssignmentPlan,
  ChannelMapTemplate,
  Permission,
  RecordingProfile,
  UploadPolicy,
  UploadProviderRuntimeStatus,
  WatchdogPolicy,
} from "@rakkr/shared";
import { uploadProviderSchema } from "@rakkr/shared";

import type { ChannelMapAssignmentPlanStore } from "./channel-map-assignment-plans.js";
import type { AuthResult } from "./auth-service.js";
import type { AppBindings, AuditTarget, RequirePermission } from "./http-types.js";
import type { SettingsStore } from "./settings-store.js";
import { listUploadPolicies } from "./upload-policies.js";
import type { UploadProviderStore } from "./upload-providers.js";

interface SettingsActionRouteDependencies {
  app: Hono<AppBindings>;
  channelMapAssignmentPlanStore: ChannelMapAssignmentPlanStore;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
  uploadProviderStore: UploadProviderStore;
}

interface SettingsActionState {
  enabled: boolean;
  href?: string;
  method: "GET" | "PATCH" | "POST" | "PUT";
  payload?: Record<string, unknown>;
  permission: Permission;
  reason?: string;
}

export function registerSettingsActionRoutes({
  app,
  channelMapAssignmentPlanStore,
  currentAuth,
  requirePermission,
  settingsStore,
  uploadProviderStore,
}: SettingsActionRouteDependencies) {
  app.get(
    "/api/v1/settings/recording-profiles/:profileId/actions",
    settingsRead("settings.recording_profiles.actions.read", requirePermission, async (c) => {
      const profileId = c.req.param("profileId") ?? "";
      const profile = await settingsStore.findRecordingProfile(profileId);

      return profile ? profileTarget(profile) : profileTarget({ id: profileId });
    }),
    async (c) => {
      const profile = await settingsStore.findRecordingProfile(c.req.param("profileId") ?? "");

      return profile
        ? c.json({
            data: {
              actions: updateOnlyActions(
                currentAuth(c).user?.permissions ?? [],
                `/api/v1/settings/recording-profiles/${profile.id}`,
              ),
              links: detailUpdateLinks(`/api/v1/settings/recording-profiles/${profile.id}`),
              profile,
            },
          })
        : c.json({ error: "Recording profile not found" }, 404);
    },
  );

  app.get(
    "/api/v1/settings/watchdog-policies/:policyId/actions",
    settingsRead("settings.watchdog_policies.actions.read", requirePermission, async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await settingsStore.findWatchdogPolicy(policyId);

      return policy ? watchdogTarget(policy) : watchdogTarget({ id: policyId });
    }),
    async (c) => {
      const policy = await settingsStore.findWatchdogPolicy(c.req.param("policyId") ?? "");

      return policy
        ? c.json({
            data: {
              actions: {
                ...updateOnlyActions(
                  currentAuth(c).user?.permissions ?? [],
                  `/api/v1/settings/watchdog-policies/${policy.id}`,
                ),
                calibrate: actionState({
                  href: `/api/v1/settings/watchdog-policies/${policy.id}/calibrations`,
                  method: "POST",
                  permission: "settings:manage",
                  permissions: currentAuth(c).user?.permissions ?? [],
                  ready: true,
                }),
              },
              links: {
                ...detailUpdateLinks(`/api/v1/settings/watchdog-policies/${policy.id}`),
                calibrate: `/api/v1/settings/watchdog-policies/${policy.id}/calibrations`,
              },
              policy,
            },
          })
        : c.json({ error: "Watchdog policy not found" }, 404);
    },
  );

  app.get(
    "/api/v1/settings/channel-map-templates/:templateId/actions",
    settingsRead("settings.channel_map_templates.actions.read", requirePermission, async (c) => {
      const templateId = c.req.param("templateId") ?? "";
      const template = await settingsStore.findChannelMapTemplate(templateId);

      return template ? channelMapTarget(template) : channelMapTarget({ id: templateId });
    }),
    async (c) => {
      const template = await settingsStore.findChannelMapTemplate(c.req.param("templateId") ?? "");
      const permissions = currentAuth(c).user?.permissions ?? [];

      return template
        ? c.json({
            data: {
              actions: {
                ...updateOnlyActions(
                  permissions,
                  `/api/v1/settings/channel-map-templates/${template.id}`,
                ),
                assign: actionState({
                  href: "/api/v1/settings/channel-map-assignments",
                  method: "PUT",
                  payload: { templateId: template.id },
                  permission: "settings:manage",
                  permissions,
                  ready: true,
                }),
                bulkAssign: actionState({
                  href: "/api/v1/settings/channel-map-assignments/bulk",
                  method: "PUT",
                  payload: { templateId: template.id },
                  permission: "settings:manage",
                  permissions,
                  ready: true,
                }),
                createRolloutPlan: actionState({
                  href: "/api/v1/settings/channel-map-assignment-plans",
                  method: "POST",
                  payload: { templateId: template.id },
                  permission: "settings:manage",
                  permissions,
                  ready: true,
                }),
              },
              links: {
                assign: "/api/v1/settings/channel-map-assignments",
                bulkAssign: "/api/v1/settings/channel-map-assignments/bulk",
                createRolloutPlan: "/api/v1/settings/channel-map-assignment-plans",
                ...detailUpdateLinks(`/api/v1/settings/channel-map-templates/${template.id}`),
              },
              template,
            },
          })
        : c.json({ error: "Channel map template not found" }, 404);
    },
  );

  app.get(
    "/api/v1/settings/channel-map-assignment-plans/:planId/actions",
    settingsRead(
      "settings.channel_map_assignment_plans.actions.read",
      requirePermission,
      async (c) => {
        const planId = c.req.param("planId") ?? "";
        const plan = await channelMapAssignmentPlanStore.find(planId);

        return plan ? planTarget(plan) : planTarget({ id: planId });
      },
    ),
    async (c) => {
      const plan = await channelMapAssignmentPlanStore.find(c.req.param("planId") ?? "");
      const permissions = currentAuth(c).user?.permissions ?? [];

      return plan
        ? c.json({
            data: {
              actions: {
                detail: actionState({
                  href: `/api/v1/settings/channel-map-assignment-plans/${plan.id}`,
                  method: "GET",
                  permission: "settings:read",
                  permissions,
                  ready: true,
                }),
                apply: actionState({
                  href: `/api/v1/settings/channel-map-assignment-plans/${plan.id}/apply`,
                  method: "POST",
                  permission: "settings:manage",
                  permissions,
                  ready: plan.status === "pending",
                  reason: plan.status === "pending" ? undefined : "plan_not_pending",
                }),
              },
              links: {
                apply: `/api/v1/settings/channel-map-assignment-plans/${plan.id}/apply`,
                detail: `/api/v1/settings/channel-map-assignment-plans/${plan.id}`,
              },
              plan,
            },
          })
        : c.json({ error: "Channel map assignment plan not found" }, 404);
    },
  );

  app.get(
    "/api/v1/settings/upload-providers/:provider/actions",
    settingsRead("settings.upload_providers.actions.read", requirePermission, async (c) => {
      const providerId = c.req.param("provider") ?? "";
      const provider = uploadProviderSchema.safeParse(providerId);

      return provider.success
        ? uploadProviderTarget(await uploadProviderStore.findStatus(provider.data))
        : { id: providerId, type: "upload_provider" };
    }),
    async (c) => {
      const provider = uploadProviderSchema.safeParse(c.req.param("provider") ?? "");

      if (!provider.success) {
        return c.json({ error: "Upload provider not found" }, 404);
      }

      const status = await uploadProviderStore.findStatus(provider.data);

      return status
        ? c.json({
            data: {
              actions: updateOnlyActions(
                currentAuth(c).user?.permissions ?? [],
                `/api/v1/settings/upload-providers/${status.provider}`,
              ),
              links: detailUpdateLinks(`/api/v1/settings/upload-providers/${status.provider}`),
              provider: status,
            },
          })
        : c.json({ error: "Upload provider not found" }, 404);
    },
  );

  app.get(
    "/api/v1/settings/upload-policies/:policyId/actions",
    settingsRead("settings.upload_policies.actions.read", requirePermission, async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = (await listUploadPolicies()).find((candidate) => candidate.id === policyId);

      return policy ? uploadPolicyTarget(policy) : uploadPolicyTarget({ id: policyId });
    }),
    async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = (await listUploadPolicies()).find((candidate) => candidate.id === policyId);

      return policy
        ? c.json({
            data: {
              actions: updateOnlyActions(
                currentAuth(c).user?.permissions ?? [],
                `/api/v1/settings/upload-policies/${policy.id}`,
              ),
              links: detailUpdateLinks(`/api/v1/settings/upload-policies/${policy.id}`),
              policy,
            },
          })
        : c.json({ error: "Upload policy not found" }, 404);
    },
  );
}

function settingsRead(
  action: string,
  requirePermission: RequirePermission,
  target: (c: Context<AppBindings>) => AuditTarget | Promise<AuditTarget>,
) {
  return requirePermission("settings:read", action, target);
}

function detailUpdateLinks(href: string) {
  return {
    detail: href,
    update: href,
  };
}

function updateOnlyActions(permissions: readonly Permission[], href: string) {
  return {
    detail: actionState({
      href,
      method: "GET",
      permission: "settings:read",
      permissions,
      ready: true,
    }),
    update: actionState({
      href,
      method: "PATCH",
      permission: "settings:manage",
      permissions,
      ready: true,
    }),
  };
}

function actionState({
  href,
  method,
  payload,
  permission,
  permissions,
  ready,
  reason,
}: {
  href: string;
  method: SettingsActionState["method"];
  payload?: Record<string, unknown>;
  permission: Permission;
  permissions: readonly Permission[];
  ready: boolean;
  reason?: string;
}): SettingsActionState {
  if (!permissions.includes(permission)) {
    return { enabled: false, method, permission, reason: "missing_permission" };
  }

  return ready
    ? { enabled: true, href, method, payload, permission }
    : { enabled: false, method, payload, permission, reason };
}

function profileTarget(
  profile: Pick<RecordingProfile, "id"> & Partial<Pick<RecordingProfile, "name">>,
) {
  return { id: profile.id, name: profile.name, type: "recording_profile" };
}

function watchdogTarget(
  policy: Pick<WatchdogPolicy, "id"> & Partial<Pick<WatchdogPolicy, "name">>,
) {
  return { id: policy.id, name: policy.name, type: "watchdog_policy" };
}

function channelMapTarget(
  template: Pick<ChannelMapTemplate, "id"> & Partial<Pick<ChannelMapTemplate, "name">>,
) {
  return { id: template.id, name: template.name, type: "channel_map_template" };
}

function planTarget(
  plan: Pick<ChannelMapAssignmentPlan, "id"> &
    Partial<Pick<ChannelMapAssignmentPlan, "templateId">>,
) {
  return { id: plan.id, name: plan.templateId, type: "channel_map_assignment_plan" };
}

function uploadProviderTarget(provider?: UploadProviderRuntimeStatus): AuditTarget {
  return {
    id: provider?.provider,
    name: provider?.displayName,
    type: "upload_provider",
  };
}

function uploadPolicyTarget(
  policy: Pick<UploadPolicy, "id"> & Partial<Pick<UploadPolicy, "name">>,
) {
  return { id: policy.id, name: policy.name, type: "upload_policy" };
}
