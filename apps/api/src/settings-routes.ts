import type { Context, Hono } from "hono";
import {
  channelMapTemplateAssignmentInputSchema,
  channelMapTemplateInputSchema,
  channelMapTemplateUpdateSchema,
  recordingProfileUpdateSchema,
  watchdogPolicyUpdateSchema,
  type ChannelMapTemplate,
  type ChannelMapTemplateAssignment,
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
    id: assignment.id,
    targetId: assignment.targetId,
    targetType: assignment.targetType,
    templateId: assignment.templateId,
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
