import type { Context, Hono } from "hono";
import {
  channelMapAssignmentPlanInputSchema,
  channelMapTemplateAssignmentBulkInputSchema,
  channelMapTemplateAssignmentInputSchema,
  channelMapTemplateAssignmentRollbackInputSchema,
  channelMapTemplateInputSchema,
  channelMapTemplateUpdateSchema,
  recordingProfileUpdateSchema,
  uploadProviderConfigUpdateSchema,
  uploadProviderSchema,
  watchdogPolicyUpdateSchema,
  type ChannelMapTemplate,
  type ChannelMapTemplateAssignment,
  type ChannelMapAssignmentPlan,
  type RecordingProfile,
  type UploadProviderRuntimeStatus,
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
import { createUploadProviderStore, type UploadProviderStore } from "./upload-providers.js";
import { registerSettingsActionRoutes } from "./settings-action-routes.js";
import { registerSettingsControllerRoutes } from "./settings-controller-routes.js";
import { registerSettingsDetailRoutes } from "./settings-detail-routes.js";
import { registerSettingsReadRoutes } from "./settings-read-routes.js";
import { registerSettingsUploadPolicyRoutes } from "./settings-upload-policy-routes.js";
import {
  channelMapTemplateSettingsTarget,
  firstHiddenChannelMapAssignmentTarget,
  profileSettingsTarget,
  uniqueChannelMapAssignmentTargets,
  uploadProviderSettingsTarget,
  watchdogSettingsTarget,
} from "./settings-scope.js";

interface SettingsRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  hasResourceScope?(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
  channelMapAssignmentPlanStore?: ChannelMapAssignmentPlanStore;
  controllerSettingsStore?: ControllerSettingsStore;
  uploadProviderStore?: UploadProviderStore;
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
  uploadProviderStore = createUploadProviderStore(),
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
    uploadProviderStore,
  });
  registerSettingsDetailRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentAuth,
    hasResourceScope,
    recordAuditEvent,
    requirePermission,
    settingsStore,
    uploadProviderStore,
  });
  registerSettingsActionRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentAuth,
    hasResourceScope,
    recordAuditEvent,
    requirePermission,
    settingsStore,
    uploadProviderStore,
  });
  registerSettingsUploadPolicyRoutes({
    app,
    currentAuth,
    recordAuditEvent,
    requirePermission,
  });

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

  app.patch(
    "/api/v1/settings/upload-providers/:provider",
    requirePermission("settings:manage", "settings.upload_providers.update", async (c) => {
      const provider = uploadProviderSchema.safeParse(c.req.param("provider"));

      return provider.success
        ? uploadProviderSettingsTarget(await uploadProviderStore.findStatus(provider.data))
        : { id: c.req.param("provider"), type: "upload_provider" };
    }),
    async (c) => {
      const provider = uploadProviderSchema.safeParse(c.req.param("provider"));

      if (!provider.success) {
        await recordSettingsFailure(
          c,
          "settings.upload_providers.update.failed",
          "provider_not_found",
          { id: c.req.param("provider"), type: "upload_provider" },
        );
        return c.json({ error: "Upload provider not found" }, 404);
      }

      const before = await uploadProviderStore.findStatus(provider.data);
      const body = uploadProviderConfigUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.upload_providers.update.failed",
          "invalid_request",
          uploadProviderSettingsTarget(before),
        );
        return c.json({ error: "Invalid upload provider", issues: body.error.issues }, 400);
      }

      const updated = await uploadProviderStore.update(provider.data, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.upload_providers.update.failed",
          "provider_not_found",
          uploadProviderSettingsTarget(before),
        );
        return c.json({ error: "Upload provider not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.upload_providers.update.succeeded",
        after: uploadProviderSnapshot(updated),
        auth: currentAuth(c),
        before: uploadProviderSnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadProviderSettingsTarget(updated),
      });

      return c.json({ data: updated });
    },
  );

  app.post(
    "/api/v1/settings/channel-map-templates",
    requirePermission("settings:manage", "settings.channel_map_templates.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = channelMapTemplateInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_templates.create.failed",
          "invalid_request",
        );
        return c.json({ error: "Invalid channel map template", issues: body.error.issues }, 400);
      }

      const created = await settingsStore.createChannelMapTemplate(body.data);

      await recordAuditEvent(c, {
        action: "settings.channel_map_templates.create.succeeded",
        after: channelMapSnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: channelMapTemplateSettingsTarget(created),
      });

      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/channel-map-templates/:templateId",
    requirePermission("settings:manage", "settings.channel_map_templates.update", async (c) => {
      const templateId = c.req.param("templateId") ?? "";
      const template = await settingsStore.findChannelMapTemplate(templateId);

      return template
        ? channelMapTemplateSettingsTarget(template)
        : { id: templateId, type: "channel_map_template" };
    }),
    async (c) => {
      const templateId = c.req.param("templateId");
      const before = await settingsStore.findChannelMapTemplate(templateId);

      if (!before) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_templates.update.failed",
          "not_found",
          {
            id: templateId,
            type: "channel_map_template",
          },
        );
        return c.json({ error: "Channel map template not found" }, 404);
      }

      const body = channelMapTemplateUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_templates.update.failed",
          "invalid_request",
          channelMapTemplateSettingsTarget(before),
        );
        return c.json({ error: "Invalid channel map template", issues: body.error.issues }, 400);
      }

      const updated = await settingsStore.updateChannelMapTemplate(templateId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_templates.update.failed",
          "not_found",
          channelMapTemplateSettingsTarget(before),
        );
        return c.json({ error: "Channel map template not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.channel_map_templates.update.succeeded",
        after: channelMapSnapshot(updated),
        auth: currentAuth(c),
        before: channelMapSnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: channelMapTemplateSettingsTarget(updated),
      });

      return c.json({ data: updated });
    },
  );

  app.put(
    "/api/v1/settings/channel-map-assignments",
    requirePermission("settings:manage", "settings.channel_map_assignments.update", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = channelMapTemplateAssignmentInputSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignments.update.failed",
          "invalid_request",
        );
        return c.json({ error: "Invalid channel map assignment", issues: body.error.issues }, 400);
      }

      const scopeDenied = await denyHiddenAssignmentTargets(
        c,
        "settings.channel_map_assignments.update.failed",
        [{ targetId: body.data.targetId, targetType: body.data.targetType }],
      );

      if (scopeDenied) {
        return scopeDenied;
      }

      const template = await settingsStore.findChannelMapTemplate(body.data.templateId);

      if (!template) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignments.update.failed",
          "template_not_found",
          {
            id: body.data.templateId,
            type: "channel_map_template",
          },
        );
        return c.json({ error: "Channel map template not found" }, 404);
      }

      const assignment = await settingsStore.assignChannelMapTemplate(
        body.data,
        currentAuth(c).user?.id,
      );

      await recordAuditEvent(c, {
        action: "settings.channel_map_assignments.update.succeeded",
        after: assignmentSnapshot(assignment),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: assignmentAuditTarget(assignment),
      });

      return c.json({ data: assignment });
    },
  );

  app.put(
    "/api/v1/settings/channel-map-assignments/bulk",
    requirePermission("settings:manage", "settings.channel_map_assignments.bulk_update", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = channelMapTemplateAssignmentBulkInputSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignments.bulk_update.failed",
          "invalid_request",
        );
        return c.json({ error: "Invalid channel map assignments", issues: body.error.issues }, 400);
      }

      const targets = uniqueChannelMapAssignmentTargets(body.data.targets);
      const scopeDenied = await denyHiddenAssignmentTargets(
        c,
        "settings.channel_map_assignments.bulk_update.failed",
        targets,
      );

      if (scopeDenied) {
        return scopeDenied;
      }

      const template = await settingsStore.findChannelMapTemplate(body.data.templateId);

      if (!template) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignments.bulk_update.failed",
          "template_not_found",
          {
            id: body.data.templateId,
            type: "channel_map_template",
          },
        );
        return c.json({ error: "Channel map template not found" }, 404);
      }

      const assignments: ChannelMapTemplateAssignment[] = [];

      for (const target of targets) {
        assignments.push(
          await settingsStore.assignChannelMapTemplate(
            {
              targetId: target.targetId,
              targetType: target.targetType,
              templateId: body.data.templateId,
            },
            currentAuth(c).user?.id,
          ),
        );
      }

      await recordAuditEvent(c, {
        action: "settings.channel_map_assignments.bulk_update.succeeded",
        after: {
          assignments: assignments.map(assignmentSnapshot),
          targetCount: assignments.length,
          templateId: body.data.templateId,
        },
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: {
          id: template.id,
          name: template.name,
          type: "channel_map_assignment_collection",
        },
      });

      return c.json({ data: assignments });
    },
  );

  app.post(
    "/api/v1/settings/channel-map-assignment-plans",
    requirePermission("settings:manage", "settings.channel_map_assignment_plans.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = channelMapAssignmentPlanInputSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignment_plans.create.failed",
          "invalid_request",
        );
        return c.json(
          { error: "Invalid channel map assignment plan", issues: body.error.issues },
          400,
        );
      }

      const targets = uniqueChannelMapAssignmentTargets(body.data.targets);
      const scopeDenied = await denyHiddenAssignmentTargets(
        c,
        "settings.channel_map_assignment_plans.create.failed",
        targets,
      );

      if (scopeDenied) {
        return scopeDenied;
      }

      const template = await settingsStore.findChannelMapTemplate(body.data.templateId);

      if (!template) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignment_plans.create.failed",
          "template_not_found",
          {
            id: body.data.templateId,
            type: "channel_map_template",
          },
        );
        return c.json({ error: "Channel map template not found" }, 404);
      }

      const plan = await channelMapAssignmentPlanStore.create(
        { ...body.data, targets },
        currentAuth(c).user?.id,
      );

      await recordAuditEvent(c, {
        action: "settings.channel_map_assignment_plans.create.succeeded",
        after: planSnapshot(plan),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: planAuditTarget(plan),
      });

      return c.json({ data: plan }, 201);
    },
  );

  app.post(
    "/api/v1/settings/channel-map-assignment-plans/:planId/apply",
    requirePermission(
      "settings:manage",
      "settings.channel_map_assignment_plans.apply",
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

        return (
          hiddenTarget ??
          (plan ? planAuditTarget(plan) : { id: planId, type: "channel_map_assignment_plan" })
        );
      },
    ),
    async (c) => {
      const planId = c.req.param("planId");
      const before = await channelMapAssignmentPlanStore.find(planId);

      if (!before) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignment_plans.apply.failed",
          "plan_not_found",
          {
            id: planId,
            type: "channel_map_assignment_plan",
          },
        );
        return c.json({ error: "Channel map assignment plan not found" }, 404);
      }

      if (before.status !== "pending") {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignment_plans.apply.failed",
          "plan_not_pending",
          planAuditTarget(before),
        );
        return c.json({ error: "Channel map assignment plan is not pending" }, 409);
      }

      const template = await settingsStore.findChannelMapTemplate(before.templateId);

      if (!template) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignment_plans.apply.failed",
          "template_not_found",
          {
            id: before.templateId,
            type: "channel_map_template",
          },
        );
        return c.json({ error: "Channel map template not found" }, 404);
      }

      const assignments: ChannelMapTemplateAssignment[] = [];

      for (const target of before.targets) {
        assignments.push(
          await settingsStore.assignChannelMapTemplate(
            {
              targetId: target.targetId,
              targetType: target.targetType,
              templateId: before.templateId,
            },
            currentAuth(c).user?.id,
          ),
        );
      }

      const applied = await channelMapAssignmentPlanStore.apply(planId, currentAuth(c).user?.id);

      await recordAuditEvent(c, {
        action: "settings.channel_map_assignment_plans.apply.succeeded",
        after: {
          assignments: assignments.map(assignmentSnapshot),
          plan: applied ? planSnapshot(applied) : undefined,
          targetCount: assignments.length,
        },
        auth: currentAuth(c),
        before: planSnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: planAuditTarget(applied ?? before),
      });

      return c.json({ data: { assignments, plan: applied } });
    },
  );

  app.post(
    "/api/v1/settings/channel-map-assignments/rollback",
    requirePermission("settings:manage", "settings.channel_map_assignments.rollback", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = channelMapTemplateAssignmentRollbackInputSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignments.rollback.failed",
          "invalid_request",
        );
        return c.json({ error: "Invalid channel map rollback", issues: body.error.issues }, 400);
      }

      const scopeDenied = await denyHiddenAssignmentTargets(
        c,
        "settings.channel_map_assignments.rollback.failed",
        [{ targetId: body.data.targetId, targetType: body.data.targetType }],
      );

      if (scopeDenied) {
        return scopeDenied;
      }

      const before = (await settingsStore.listChannelMapAssignments()).find(
        (assignment) =>
          assignment.targetType === body.data.targetType &&
          assignment.targetId === body.data.targetId,
      );
      const rolledBack = await settingsStore.rollbackChannelMapAssignment(
        body.data.targetType,
        body.data.targetId,
        currentAuth(c).user?.id,
      );

      if (!rolledBack) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_assignments.rollback.failed",
          "rollback_target_not_found",
          {
            id: `${body.data.targetType}:${body.data.targetId}`,
            type: "channel_map_assignment",
          },
        );
        return c.json({ error: "Channel map assignment cannot be rolled back" }, 409);
      }

      await recordAuditEvent(c, {
        action: "settings.channel_map_assignments.rollback.succeeded",
        after: assignmentSnapshot(rolledBack),
        auth: currentAuth(c),
        before: before ? assignmentSnapshot(before) : undefined,
        outcome: "succeeded",
        permission: "settings:manage",
        target: assignmentAuditTarget(rolledBack),
      });

      return c.json({ data: rolledBack });
    },
  );

  async function denyHiddenAssignmentTargets(
    c: Context<AppBindings>,
    action: string,
    targets: Array<Pick<ChannelMapTemplateAssignment, "targetId" | "targetType">>,
  ) {
    const hiddenTarget = await firstHiddenChannelMapAssignmentTarget(
      currentAuth(c).user,
      targets,
      hasResourceScope,
    );

    if (!hiddenTarget) {
      return undefined;
    }

    await recordSettingsFailure(c, action, "missing_resource_scope", hiddenTarget);

    return c.json({ error: "Forbidden", permission: "settings:manage" }, 403);
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

function channelMapSnapshot(template: ChannelMapTemplate) {
  return {
    channelMode: template.channelMode,
    entries: template.entries,
    id: template.id,
    name: template.name,
    tags: template.tags,
  };
}

function assignmentAuditTarget(assignment: ChannelMapTemplateAssignment) {
  return {
    id: `${assignment.targetType}:${assignment.targetId}`,
    name: assignment.templateId,
    type: "channel_map_assignment",
  };
}

function assignmentSnapshot(assignment: ChannelMapTemplateAssignment) {
  return {
    assignedAt: assignment.assignedAt,
    history: assignment.history,
    id: assignment.id,
    targetId: assignment.targetId,
    targetType: assignment.targetType,
    templateId: assignment.templateId,
  };
}

function planAuditTarget(plan: ChannelMapAssignmentPlan) {
  return {
    id: plan.id,
    name: plan.templateId,
    type: "channel_map_assignment_plan",
  };
}

function planSnapshot(plan: ChannelMapAssignmentPlan) {
  return {
    appliedAt: plan.appliedAt,
    appliedByUserId: plan.appliedByUserId,
    createdAt: plan.createdAt,
    createdByUserId: plan.createdByUserId,
    id: plan.id,
    note: plan.note,
    status: plan.status,
    targetCount: plan.targets.length,
    targets: plan.targets,
    templateId: plan.templateId,
  };
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

function uploadProviderSnapshot(provider: UploadProviderRuntimeStatus) {
  return {
    configured: provider.configured,
    credentialRef: provider.credentialRef,
    displayName: provider.displayName,
    enabled: provider.enabled,
    implemented: provider.implemented,
    missingFields: provider.missingFields,
    provider: provider.provider,
    status: provider.status,
    target: provider.target,
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
