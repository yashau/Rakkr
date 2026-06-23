import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const settingsActionRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-actions-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  settingsActionRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_PLAN_STORE_PATH = path.join(
  settingsActionRoot,
  "channel-map-assignment-plans.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  settingsActionRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(settingsActionRoot, "profiles.json");
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(
  settingsActionRoot,
  "retention-policies.json",
);
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(settingsActionRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(
  settingsActionRoot,
  "upload-providers.json",
);
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(
  settingsActionRoot,
  "watchdog-policies.json",
);

const { createAuditStore } = await import("../src/audit-store.js");
const { createChannelMapAssignmentPlanStore } =
  await import("../src/channel-map-assignment-plans.js");
const { createRetentionPolicy } = await import("../src/retention-policies.js");
const { registerRetentionPolicyRoutes } = await import("../src/retention-policy-routes.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadProviderStore } = await import("../src/upload-providers.js");

test.after(async () => {
  await rm(settingsActionRoot, { force: true, recursive: true });
});

test("settings action summaries expose ready links for managed resources", async () => {
  const app = new Hono<AppBindings>();
  const currentUser = viewer(["settings:manage", "settings:read"]);
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const uploadProviderStore = createUploadProviderStore();
  const template = await settingsStore.createChannelMapTemplate(
    channelMapInput(`channel_map_actions_${randomUUID()}`, "Action Summary Map"),
  );
  const plan = await channelMapAssignmentPlanStore.create({
    targets: [{ targetId: "node_settings_actions", targetType: "node" }],
    templateId: template.id,
  });
  const uploadPolicy = await createUploadPolicy({
    enabled: true,
    id: `upload-policy-actions-${randomUUID()}`,
    maxAttempts: 3,
    name: "Action Summary Upload",
    provider: "stub",
    target: "stub://actions",
    trigger: "manual",
  });
  const retentionPolicy = await createRetentionPolicy({
    action: "delete_cache",
    id: `retention-actions-${randomUUID()}`,
    maxAgeDays: 30,
    name: "Action Summary Retention",
    scope: "controller_cache",
  });

  const auditStore = registerAllSettingsRoutes({
    app,
    channelMapAssignmentPlanStore,
    currentUser,
    settingsStore,
    uploadProviderStore,
  });

  const profile = await actions(app, "/api/v1/settings/recording-profiles/voice-mp3-vbr/actions");
  const watchdog = await actions(
    app,
    "/api/v1/settings/watchdog-policies/scheduled-voice-watchdog/actions",
  );
  const templateSummary = await actions(
    app,
    `/api/v1/settings/channel-map-templates/${template.id}/actions`,
  );
  const planSummary = await actions(
    app,
    `/api/v1/settings/channel-map-assignment-plans/${plan.id}/actions`,
  );
  const provider = await actions(app, "/api/v1/settings/upload-providers/stub/actions");
  const upload = await actions(app, `/api/v1/settings/upload-policies/${uploadPolicy.id}/actions`);
  const retention = await actions(
    app,
    `/api/v1/settings/retention-policies/${retentionPolicy.id}/actions`,
  );

  assert.equal(profile.actions.update.enabled, true);
  assert.equal(profile.actions.update.href, "/api/v1/settings/recording-profiles/voice-mp3-vbr");
  assert.equal(watchdog.actions.calibrate.enabled, true);
  assert.equal(
    watchdog.actions.calibrate.href,
    "/api/v1/settings/watchdog-policies/scheduled-voice-watchdog/calibrations",
  );
  assert.deepEqual(templateSummary.actions.assign.payload, { templateId: template.id });
  assert.deepEqual(templateSummary.actions.bulkAssign.payload, { templateId: template.id });
  assert.deepEqual(templateSummary.actions.createRolloutPlan.payload, {
    templateId: template.id,
  });
  assert.equal(planSummary.actions.apply.enabled, true);
  assert.equal(provider.actions.update.href, "/api/v1/settings/upload-providers/stub");
  assert.equal(upload.actions.update.href, `/api/v1/settings/upload-policies/${uploadPolicy.id}`);
  assert.equal(
    retention.actions.update.href,
    `/api/v1/settings/retention-policies/${retentionPolicy.id}`,
  );

  const auditActions = (await auditStore.list({ outcome: "succeeded" }))
    .map((event) => [event.action, event.permission, event.details.visibleActionCount])
    .sort();

  assert.deepEqual(auditActions, [
    ["settings.channel_map_assignment_plans.actions.read.succeeded", "settings:read", 2],
    ["settings.channel_map_templates.actions.read.succeeded", "settings:read", 5],
    ["settings.recording_profiles.actions.read.succeeded", "settings:read", 2],
    ["settings.retention_policies.actions.read.succeeded", "settings:read", 2],
    ["settings.upload_policies.actions.read.succeeded", "settings:read", 2],
    ["settings.upload_providers.actions.read.succeeded", "settings:read", 2],
    ["settings.watchdog_policies.actions.read.succeeded", "settings:read", 3],
  ]);
});

test("settings action summaries explain missing permission and rollout blockers", async () => {
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const uploadProviderStore = createUploadProviderStore();
  const template = await settingsStore.createChannelMapTemplate(
    channelMapInput(`channel_map_blocked_${randomUUID()}`, "Blocked Action Map"),
  );
  const plan = await channelMapAssignmentPlanStore.create({
    targets: [{ targetId: "node_settings_blocked", targetType: "node" }],
    templateId: template.id,
  });

  await channelMapAssignmentPlanStore.apply(plan.id, "user_settings_action_test");

  const readOnlyApp = new Hono<AppBindings>();
  registerAllSettingsRoutes({
    app: readOnlyApp,
    channelMapAssignmentPlanStore,
    currentUser: viewer(["settings:read"]),
    settingsStore,
    uploadProviderStore,
  });

  const readOnlyPlan = await actions(
    readOnlyApp,
    `/api/v1/settings/channel-map-assignment-plans/${plan.id}/actions`,
  );
  const readOnlyTemplate = await actions(
    readOnlyApp,
    `/api/v1/settings/channel-map-templates/${template.id}/actions`,
  );

  assert.equal(readOnlyPlan.actions.apply.enabled, false);
  assert.equal(readOnlyPlan.actions.apply.reason, "missing_permission");
  assert.equal(readOnlyTemplate.actions.assign.enabled, false);
  assert.equal(readOnlyTemplate.actions.assign.reason, "missing_permission");

  const managerApp = new Hono<AppBindings>();
  registerAllSettingsRoutes({
    app: managerApp,
    channelMapAssignmentPlanStore,
    currentUser: viewer(["settings:manage", "settings:read"]),
    settingsStore,
    uploadProviderStore,
  });

  const managerPlan = await actions(
    managerApp,
    `/api/v1/settings/channel-map-assignment-plans/${plan.id}/actions`,
  );

  assert.equal(managerPlan.actions.apply.enabled, false);
  assert.equal(managerPlan.actions.apply.reason, "plan_not_pending");
});

test("settings action summary routes deny users without settings read", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer([]);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore: createChannelMapAssignmentPlanStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, currentUser),
    settingsStore: createSettingsStore(),
    uploadProviderStore: createUploadProviderStore(),
  });

  const responses = await Promise.all([
    app.request("/api/v1/settings/recording-profiles/voice-mp3-vbr/actions"),
    app.request("/api/v1/settings/watchdog-policies/scheduled-voice-watchdog/actions"),
    app.request("/api/v1/settings/channel-map-templates/template_missing/actions"),
    app.request("/api/v1/settings/channel-map-assignment-plans/plan_missing/actions"),
    app.request("/api/v1/settings/upload-providers/stub/actions"),
    app.request("/api/v1/settings/upload-policies/upload-policy-missing/actions"),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:read" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.actions.read",
    "settings.channel_map_templates.actions.read",
    "settings.recording_profiles.actions.read",
    "settings.upload_policies.actions.read",
    "settings.upload_providers.actions.read",
    "settings.watchdog_policies.actions.read",
  ]);
});

test("settings action summary routes audit missing resources", async () => {
  const app = new Hono<AppBindings>();
  const currentUser = viewer(["settings:read"]);
  const auditStore = registerAllSettingsRoutes({
    app,
    channelMapAssignmentPlanStore: createChannelMapAssignmentPlanStore(),
    currentUser,
    settingsStore: createSettingsStore(),
    uploadProviderStore: createUploadProviderStore(),
  });

  const responses = await Promise.all([
    app.request("/api/v1/settings/recording-profiles/profile_missing/actions"),
    app.request("/api/v1/settings/watchdog-policies/watchdog_missing/actions"),
    app.request("/api/v1/settings/channel-map-templates/template_missing/actions"),
    app.request("/api/v1/settings/channel-map-assignment-plans/plan_missing/actions"),
    app.request("/api/v1/settings/upload-providers/not-a-provider/actions"),
    app.request("/api/v1/settings/upload-policies/upload-policy-missing/actions"),
    app.request("/api/v1/settings/retention-policies/retention-missing/actions"),
  ]);
  const failedEvents = await auditStore.list({ outcome: "failed", permission: "settings:read" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [404, 404, 404, 404, 404, 404, 404],
  );
  assert.deepEqual(failedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.actions.read.failed",
    "settings.channel_map_templates.actions.read.failed",
    "settings.recording_profiles.actions.read.failed",
    "settings.retention_policies.actions.read.failed",
    "settings.upload_policies.actions.read.failed",
    "settings.upload_providers.actions.read.failed",
    "settings.watchdog_policies.actions.read.failed",
  ]);
  assert.ok(failedEvents.every((event) => event.reason === "not_found"));
  assert.ok(failedEvents.every((event) => event.actor.id === currentUser.id));
});

async function actions(app: Hono<AppBindings>, targetPath: string) {
  const response = await app.request(targetPath);
  const body = (await response.json()) as {
    data: { actions: Record<string, { enabled: boolean; href?: string; reason?: string }> };
  };

  assert.equal(response.status, 200);

  return body.data;
}

function registerAllSettingsRoutes({
  app,
  channelMapAssignmentPlanStore,
  currentUser,
  settingsStore,
  uploadProviderStore,
}: {
  app: Hono<AppBindings>;
  channelMapAssignmentPlanStore: ReturnType<typeof createChannelMapAssignmentPlanStore>;
  currentUser: CurrentUser;
  settingsStore: ReturnType<typeof createSettingsStore>;
  uploadProviderStore: ReturnType<typeof createUploadProviderStore>;
}) {
  const auditStore = createAuditStore("");

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore,
    uploadProviderStore,
  });
  registerRetentionPolicyRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
  });

  return auditStore;
}

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function denyMissingPermission(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
): RequirePermission {
  return (permission, action, target) => async (c) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      outcome: "denied",
      permission,
      reason: "missing_permission",
      target: auditTarget,
    });

    return c.json({ error: "Forbidden", permission }, 403);
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const actor = input.actor ?? {
      id: input.auth?.user?.id ?? "anonymous",
      name: input.auth?.user?.name ?? "Anonymous",
      roles: input.auth?.user?.roles ?? [],
      type: "user" as const,
    };
    const event: AuditEvent = {
      action: input.action,
      actor,
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function viewer(permissions = ["settings:read"]): CurrentUser {
  return {
    email: "settings-actions@example.com",
    groups: [],
    id: "user_settings_actions_test",
    name: "Settings Actions Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}

function channelMapInput(id: string, name: string) {
  return {
    channelMode: "mono_to_stereo_mix",
    entries: [
      {
        included: true,
        label: "Action Channel",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    id,
    name,
    tags: ["actions"],
  };
}
