import type { Context, Hono } from "hono";
import {
  channelMapAssignmentPlanInputSchema,
  channelMapTemplateAssignmentBulkInputSchema,
  channelMapTemplateAssignmentInputSchema,
  channelMapTemplateAssignmentRollbackInputSchema,
  channelMapTemplateInputSchema,
  channelMapTemplateUpdateSchema,
  recordingProfileUpdateSchema,
  uploadPolicyInputSchema,
  uploadPolicyUpdateSchema,
  uploadProviderConfigUpdateSchema,
  uploadProviderSchema,
  watchdogPolicyUpdateSchema,
  type ChannelMapTemplate,
  type ChannelMapTemplateAssignment,
  type ChannelMapAssignmentPlan,
  type RecordingProfile,
  type UploadPolicy,
  type UploadProviderRuntimeStatus,
  type WatchdogPolicy,
} from "@rakkr/shared";

import {
  createChannelMapAssignmentPlanStore,
  type ChannelMapAssignmentPlanStore,
} from "./channel-map-assignment-plans.js";
import type { AuthResult } from "./auth-service.js";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "./http-types.js";
import type { SettingsStore } from "./settings-store.js";
import { createUploadPolicy, listUploadPolicies, updateUploadPolicy } from "./upload-policies.js";
import { createUploadProviderStore, type UploadProviderStore } from "./upload-providers.js";
import { registerSettingsActionRoutes } from "./settings-action-routes.js";
import { registerSettingsDetailRoutes } from "./settings-detail-routes.js";

interface SettingsRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
  channelMapAssignmentPlanStore?: ChannelMapAssignmentPlanStore;
  uploadProviderStore?: UploadProviderStore;
}

export function registerSettingsRoutes({
  app,
  currentAuth,
  channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore(),
  recordAuditEvent,
  requirePermission,
  settingsStore,
  uploadProviderStore = createUploadProviderStore(),
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

  app.get(
    "/api/v1/settings/channel-map-templates",
    requirePermission("settings:read", "settings.channel_map_templates.read", () => ({
      type: "settings",
    })),
    async (c) => c.json({ data: await settingsStore.listChannelMapTemplates() }),
  );

  app.get(
    "/api/v1/settings/channel-map-assignments",
    requirePermission("settings:read", "settings.channel_map_assignments.read", () => ({
      type: "settings",
    })),
    async (c) => c.json({ data: await settingsStore.listChannelMapAssignments() }),
  );

  app.get(
    "/api/v1/settings/channel-map-assignment-plans",
    requirePermission("settings:read", "settings.channel_map_assignment_plans.read", () => ({
      type: "settings",
    })),
    async (c) => c.json({ data: await channelMapAssignmentPlanStore.list() }),
  );

  app.get(
    "/api/v1/settings/upload-providers",
    requirePermission("settings:read", "settings.upload_providers.read", () => ({
      type: "settings",
    })),
    async (c) => c.json({ data: await uploadProviderStore.listStatuses() }),
  );

  app.get(
    "/api/v1/settings/upload-policies",
    requirePermission("settings:read", "settings.upload_policies.read", () => ({
      type: "settings",
    })),
    async (c) => c.json({ data: await listUploadPolicies() }),
  );

  registerSettingsDetailRoutes({
    app,
    channelMapAssignmentPlanStore,
    requirePermission,
    settingsStore,
    uploadProviderStore,
  });
  registerSettingsActionRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentAuth,
    requirePermission,
    settingsStore,
    uploadProviderStore,
  });

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

  app.patch(
    "/api/v1/settings/upload-providers/:provider",
    requirePermission("settings:manage", "settings.upload_providers.update", () => ({
      type: "settings",
    })),
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
          uploadProviderAuditTarget(before),
        );
        return c.json({ error: "Invalid upload provider", issues: body.error.issues }, 400);
      }

      const updated = await uploadProviderStore.update(provider.data, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.upload_providers.update.failed",
          "provider_not_found",
          uploadProviderAuditTarget(before),
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
        target: uploadProviderAuditTarget(updated),
      });

      return c.json({ data: updated });
    },
  );

  app.post(
    "/api/v1/settings/upload-policies",
    requirePermission("settings:manage", "settings.upload_policies.create", () => ({
      type: "settings",
    })),
    async (c) => {
      const body = uploadPolicyInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(c, "settings.upload_policies.create.failed", "invalid_request");
        return c.json({ error: "Invalid upload policy", issues: body.error.issues }, 400);
      }

      const created = await createUploadPolicy(body.data);

      await recordAuditEvent(c, {
        action: "settings.upload_policies.create.succeeded",
        after: uploadPolicySnapshot(created),
        auth: currentAuth(c),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadPolicyAuditTarget(created),
      });

      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/upload-policies/:policyId",
    requirePermission("settings:manage", "settings.upload_policies.update", () => ({
      type: "settings",
    })),
    async (c) => {
      const policyId = c.req.param("policyId");
      const before = (await listUploadPolicies()).find((policy) => policy.id === policyId);

      if (!before) {
        await recordSettingsFailure(c, "settings.upload_policies.update.failed", "not_found", {
          id: policyId,
          type: "upload_policy",
        });
        return c.json({ error: "Upload policy not found" }, 404);
      }

      const body = uploadPolicyUpdateSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordSettingsFailure(
          c,
          "settings.upload_policies.update.failed",
          "invalid_request",
          uploadPolicyAuditTarget(before),
        );
        return c.json({ error: "Invalid upload policy", issues: body.error.issues }, 400);
      }

      const updated = await updateUploadPolicy(policyId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.upload_policies.update.failed",
          "not_found",
          uploadPolicyAuditTarget(before),
        );
        return c.json({ error: "Upload policy not found" }, 404);
      }

      await recordAuditEvent(c, {
        action: "settings.upload_policies.update.succeeded",
        after: uploadPolicySnapshot(updated),
        auth: currentAuth(c),
        before: uploadPolicySnapshot(before),
        outcome: "succeeded",
        permission: "settings:manage",
        target: uploadPolicyAuditTarget(updated),
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
        target: channelMapAuditTarget(created),
      });

      return c.json({ data: created }, 201);
    },
  );

  app.patch(
    "/api/v1/settings/channel-map-templates/:templateId",
    requirePermission("settings:manage", "settings.channel_map_templates.update", () => ({
      type: "settings",
    })),
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
          channelMapAuditTarget(before),
        );
        return c.json({ error: "Invalid channel map template", issues: body.error.issues }, 400);
      }

      const updated = await settingsStore.updateChannelMapTemplate(templateId, body.data);

      if (!updated) {
        await recordSettingsFailure(
          c,
          "settings.channel_map_templates.update.failed",
          "not_found",
          channelMapAuditTarget(before),
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
        target: channelMapAuditTarget(updated),
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

      for (const target of uniqueAssignmentTargets(body.data.targets)) {
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

      const plan = await channelMapAssignmentPlanStore.create(body.data, currentAuth(c).user?.id);

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
    requirePermission("settings:manage", "settings.channel_map_assignment_plans.apply", () => ({
      type: "settings",
    })),
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

function channelMapAuditTarget(template: ChannelMapTemplate) {
  return {
    id: template.id,
    name: template.name,
    type: "channel_map_template",
  };
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

function uniqueAssignmentTargets(
  targets: Array<{
    targetId: string;
    targetType: ChannelMapTemplateAssignment["targetType"];
  }>,
) {
  const seen = new Set<string>();

  return targets.filter((target) => {
    const key = `${target.targetType}:${target.targetId}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
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

function watchdogAuditTarget(policy: WatchdogPolicy) {
  return {
    id: policy.id,
    name: policy.name,
    type: "watchdog_policy",
  };
}

function uploadProviderAuditTarget(provider: UploadProviderRuntimeStatus) {
  return {
    id: provider.provider,
    name: provider.displayName,
    type: "upload_provider",
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

function uploadPolicyAuditTarget(policy: UploadPolicy) {
  return {
    id: policy.id,
    name: policy.name,
    type: "upload_policy",
  };
}

function uploadPolicySnapshot(policy: UploadPolicy) {
  return {
    enabled: policy.enabled,
    id: policy.id,
    maxAttempts: policy.maxAttempts,
    name: policy.name,
    provider: policy.provider,
    target: policy.target,
    trigger: policy.trigger,
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
