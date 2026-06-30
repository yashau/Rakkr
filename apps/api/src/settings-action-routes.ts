import type { Context, Hono } from "hono";
import type { ChannelMapAssignmentPlan, Permission, RecordingProfile } from "@rakkr/shared";

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
  channelMapTemplateSettingsTarget,
  firstHiddenChannelMapAssignmentTarget,
  uploadDestinationSettingsTarget,
  uploadPolicySettingsTarget,
  watchdogSettingsTarget,
} from "./settings-scope.js";
import { findUploadPolicy } from "./upload-policies.js";
import type { UploadDestinationStore } from "./upload-destinations.js";

interface SettingsActionRouteDependencies {
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
  uploadDestinationStore: UploadDestinationStore;
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
  hasResourceScope,
  recordAuditEvent,
  requirePermission,
  settingsStore,
  uploadDestinationStore,
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

      if (!profile) {
        await recordSettingsActionRead(c, {
          action: "settings.recording_profiles.actions.read.failed",
          auth: currentAuth(c),
          recordAuditEvent,
          reason: "not_found",
          target: profileTarget({ id: c.req.param("profileId") ?? "" }),
        });

        return c.json({ error: "Recording profile not found" }, 404);
      }

      const actions = updateOnlyActions(
        currentAuth(c).user?.permissions ?? [],
        `/api/v1/settings/recording-profiles/${profile.id}`,
      );

      await recordSettingsActionRead(c, {
        action: "settings.recording_profiles.actions.read.succeeded",
        auth: currentAuth(c),
        recordAuditEvent,
        target: profileTarget(profile),
        visibleActionCount: Object.keys(actions).length,
      });

      return c.json({
        data: {
          actions,
          links: detailUpdateLinks(`/api/v1/settings/recording-profiles/${profile.id}`),
          profile,
        },
      });
    },
  );

  app.get(
    "/api/v1/settings/watchdog-policies/:policyId/actions",
    settingsRead("settings.watchdog_policies.actions.read", requirePermission, async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await settingsStore.findWatchdogPolicy(policyId);

      return policy ? watchdogSettingsTarget(policy) : { id: policyId, type: "watchdog_policy" };
    }),
    async (c) => {
      const policy = await settingsStore.findWatchdogPolicy(c.req.param("policyId") ?? "");

      if (!policy) {
        await recordSettingsActionRead(c, {
          action: "settings.watchdog_policies.actions.read.failed",
          auth: currentAuth(c),
          recordAuditEvent,
          reason: "not_found",
          target: { id: c.req.param("policyId") ?? "", type: "watchdog_policy" },
        });

        return c.json({ error: "Watchdog policy not found" }, 404);
      }

      const actions = {
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
      };

      await recordSettingsActionRead(c, {
        action: "settings.watchdog_policies.actions.read.succeeded",
        auth: currentAuth(c),
        recordAuditEvent,
        target: watchdogSettingsTarget(policy),
        visibleActionCount: Object.keys(actions).length,
      });

      return c.json({
        data: {
          actions,
          links: {
            ...detailUpdateLinks(`/api/v1/settings/watchdog-policies/${policy.id}`),
            calibrate: `/api/v1/settings/watchdog-policies/${policy.id}/calibrations`,
          },
          policy,
        },
      });
    },
  );

  app.get(
    "/api/v1/settings/channel-map-templates/:templateId/actions",
    settingsRead("settings.channel_map_templates.actions.read", requirePermission, async (c) => {
      const templateId = c.req.param("templateId") ?? "";
      const template = await settingsStore.findChannelMapTemplate(templateId);

      return template
        ? channelMapTemplateSettingsTarget(template)
        : { id: templateId, type: "channel_map_template" };
    }),
    async (c) => {
      const template = await settingsStore.findChannelMapTemplate(c.req.param("templateId") ?? "");
      const permissions = currentAuth(c).user?.permissions ?? [];

      if (!template) {
        await recordSettingsActionRead(c, {
          action: "settings.channel_map_templates.actions.read.failed",
          auth: currentAuth(c),
          recordAuditEvent,
          reason: "not_found",
          target: { id: c.req.param("templateId") ?? "", type: "channel_map_template" },
        });

        return c.json({ error: "Channel map template not found" }, 404);
      }

      const actions = {
        ...updateOnlyActions(permissions, `/api/v1/settings/channel-map-templates/${template.id}`),
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
      };

      await recordSettingsActionRead(c, {
        action: "settings.channel_map_templates.actions.read.succeeded",
        auth: currentAuth(c),
        recordAuditEvent,
        target: channelMapTemplateSettingsTarget(template),
        visibleActionCount: Object.keys(actions).length,
      });

      return c.json({
        data: {
          actions,
          links: {
            assign: "/api/v1/settings/channel-map-assignments",
            bulkAssign: "/api/v1/settings/channel-map-assignments/bulk",
            createRolloutPlan: "/api/v1/settings/channel-map-assignment-plans",
            ...detailUpdateLinks(`/api/v1/settings/channel-map-templates/${template.id}`),
          },
          template,
        },
      });
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
      const plan = await channelMapAssignmentPlanStore.find(c.req.param("planId") ?? "");
      const permissions = currentAuth(c).user?.permissions ?? [];

      if (!plan) {
        await recordSettingsActionRead(c, {
          action: "settings.channel_map_assignment_plans.actions.read.failed",
          auth: currentAuth(c),
          recordAuditEvent,
          reason: "not_found",
          target: planTarget({ id: c.req.param("planId") ?? "" }),
        });

        return c.json({ error: "Channel map assignment plan not found" }, 404);
      }

      const actions = {
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
      };

      await recordSettingsActionRead(c, {
        action: "settings.channel_map_assignment_plans.actions.read.succeeded",
        auth: currentAuth(c),
        recordAuditEvent,
        target: planTarget(plan),
        visibleActionCount: Object.keys(actions).length,
      });

      return c.json({
        data: {
          actions,
          links: {
            apply: `/api/v1/settings/channel-map-assignment-plans/${plan.id}/apply`,
            detail: `/api/v1/settings/channel-map-assignment-plans/${plan.id}`,
          },
          plan,
        },
      });
    },
  );

  app.get(
    "/api/v1/settings/upload-destinations/:id/actions",
    settingsRead("settings.upload_destinations.actions.read", requirePermission, async (c) => {
      const id = c.req.param("id") ?? "";
      const status = await uploadDestinationStore.find(id);

      return status ? uploadDestinationSettingsTarget(status) : { id, type: "upload_destination" };
    }),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const status = await uploadDestinationStore.find(id);

      if (!status) {
        await recordSettingsActionRead(c, {
          action: "settings.upload_destinations.actions.read.failed",
          auth: currentAuth(c),
          recordAuditEvent,
          reason: "not_found",
          target: { id, type: "upload_destination" },
        });

        return c.json({ error: "Upload destination not found" }, 404);
      }

      const actions = updateOnlyActions(
        currentAuth(c).user?.permissions ?? [],
        `/api/v1/settings/upload-destinations/${status.id}`,
      );

      await recordSettingsActionRead(c, {
        action: "settings.upload_destinations.actions.read.succeeded",
        auth: currentAuth(c),
        recordAuditEvent,
        target: uploadDestinationSettingsTarget(status),
        visibleActionCount: Object.keys(actions).length,
      });

      return c.json({
        data: {
          actions,
          destination: status,
          links: detailUpdateLinks(`/api/v1/settings/upload-destinations/${status.id}`),
        },
      });
    },
  );

  app.get(
    "/api/v1/settings/upload-policies/:policyId/actions",
    settingsRead("settings.upload_policies.actions.read", requirePermission, async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await findUploadPolicy(policyId);

      return policy
        ? uploadPolicySettingsTarget(policy)
        : uploadPolicySettingsTarget({ id: policyId });
    }),
    async (c) => {
      const policyId = c.req.param("policyId") ?? "";
      const policy = await findUploadPolicy(policyId);

      if (!policy) {
        await recordSettingsActionRead(c, {
          action: "settings.upload_policies.actions.read.failed",
          auth: currentAuth(c),
          recordAuditEvent,
          reason: "not_found",
          target: uploadPolicySettingsTarget({ id: policyId }),
        });

        return c.json({ error: "Upload policy not found" }, 404);
      }

      const actions = updateOnlyActions(
        currentAuth(c).user?.permissions ?? [],
        `/api/v1/settings/upload-policies/${policy.id}`,
      );

      await recordSettingsActionRead(c, {
        action: "settings.upload_policies.actions.read.succeeded",
        auth: currentAuth(c),
        recordAuditEvent,
        target: uploadPolicySettingsTarget(policy),
        visibleActionCount: Object.keys(actions).length,
      });

      return c.json({
        data: {
          actions,
          links: detailUpdateLinks(`/api/v1/settings/upload-policies/${policy.id}`),
          policy,
        },
      });
    },
  );
}

async function recordSettingsActionRead(
  c: Context<AppBindings>,
  {
    action,
    auth,
    recordAuditEvent,
    reason,
    target,
    visibleActionCount,
  }: {
    action: string;
    auth: AuthResult;
    recordAuditEvent: RecordAuditEvent;
    reason?: string;
    target: AuditTarget;
    visibleActionCount?: number;
  },
) {
  await recordAuditEvent(c, {
    action,
    auth,
    details: {
      visibleActionCount,
    },
    outcome: reason ? "failed" : "succeeded",
    permission: "settings:read",
    reason,
    target,
  });
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

function planTarget(
  plan: Pick<ChannelMapAssignmentPlan, "id"> &
    Partial<Pick<ChannelMapAssignmentPlan, "templateId">>,
) {
  return { id: plan.id, name: plan.templateId, type: "channel_map_assignment_plan" };
}
