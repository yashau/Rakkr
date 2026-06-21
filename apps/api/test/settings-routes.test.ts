import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const settingsRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_PLAN_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-assignment-plans.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  settingsRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(settingsRoot, "profiles.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(settingsRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(settingsRoot, "upload-providers.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(settingsRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createChannelMapAssignmentPlanStore } =
  await import("../src/channel-map-assignment-plans.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadProviderStore } = await import("../src/upload-providers.js");

test.after(async () => {
  await rm(settingsRoot, { force: true, recursive: true });
});

test("settings write routes deny users without settings manage", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const settingsStore = createSettingsStore();

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, currentUser),
    settingsStore,
    uploadProviderStore: createUploadProviderStore(),
  });

  const responses = await Promise.all([
    requestJson(app, "/api/v1/settings/recording-profiles/voice-mp3-vbr", "PATCH", {
      name: "Blocked Profile",
    }),
    requestJson(app, "/api/v1/settings/watchdog-policies/scheduled-voice-watchdog", "PATCH", {
      name: "Blocked Watchdog",
    }),
    requestJson(app, "/api/v1/settings/upload-providers/stub", "PATCH", {
      displayName: "Blocked Provider",
    }),
    requestJson(app, "/api/v1/settings/upload-policies", "POST", {
      enabled: true,
      maxAttempts: 1,
      name: "Blocked Upload Policy",
      provider: "stub",
      target: "stub://blocked",
      trigger: "manual",
    }),
    requestJson(app, "/api/v1/settings/upload-policies/upload-policy-stub", "PATCH", {
      name: "Blocked Upload Policy Update",
    }),
    requestJson(app, "/api/v1/settings/channel-map-templates", "POST", {
      channelMode: "mono_to_stereo_mix",
      entries: [
        {
          included: true,
          label: "Blocked Channel",
          outputChannelIndex: 1,
          sourceChannelIndex: 1,
        },
      ],
      name: "Blocked Channel Map",
      tags: ["blocked"],
    }),
    requestJson(app, "/api/v1/settings/channel-map-templates/template_blocked", "PATCH", {
      name: "Blocked Channel Map Update",
    }),
    requestJson(app, "/api/v1/settings/channel-map-assignments", "PUT", {
      targetId: "node_blocked",
      targetType: "node",
      templateId: "template_blocked",
    }),
    requestJson(app, "/api/v1/settings/channel-map-assignments/bulk", "PUT", {
      targets: [{ targetId: "node_blocked", targetType: "node" }],
      templateId: "template_blocked",
    }),
    requestJson(app, "/api/v1/settings/channel-map-assignment-plans", "POST", {
      targets: [{ targetId: "node_blocked", targetType: "node" }],
      templateId: "template_blocked",
    }),
    app.request("/api/v1/settings/channel-map-assignment-plans/plan_blocked/apply", {
      method: "POST",
    }),
    requestJson(app, "/api/v1/settings/channel-map-assignments/rollback", "POST", {
      targetId: "node_blocked",
      targetType: "node",
    }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:manage" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.apply",
    "settings.channel_map_assignment_plans.create",
    "settings.channel_map_assignments.bulk_update",
    "settings.channel_map_assignments.rollback",
    "settings.channel_map_assignments.update",
    "settings.channel_map_templates.create",
    "settings.channel_map_templates.update",
    "settings.recording_profiles.update",
    "settings.upload_policies.create",
    "settings.upload_policies.update",
    "settings.upload_providers.update",
    "settings.watchdog_policies.update",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.target.type === "settings"));
});

test("settings read routes deny users without settings read", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer([]);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, currentUser),
    settingsStore: createSettingsStore(),
    uploadProviderStore: createUploadProviderStore(),
  });

  const responses = await Promise.all([
    app.request("/api/v1/settings/recording-profiles"),
    app.request("/api/v1/settings/recording-profiles/voice-mp3-vbr"),
    app.request("/api/v1/settings/watchdog-policies"),
    app.request("/api/v1/settings/watchdog-policies/scheduled-voice-watchdog"),
    app.request("/api/v1/settings/channel-map-templates"),
    app.request("/api/v1/settings/channel-map-templates/template_missing"),
    app.request("/api/v1/settings/channel-map-assignments"),
    app.request("/api/v1/settings/channel-map-assignment-plans"),
    app.request("/api/v1/settings/channel-map-assignment-plans/plan_missing"),
    app.request("/api/v1/settings/upload-providers"),
    app.request("/api/v1/settings/upload-providers/stub"),
    app.request("/api/v1/settings/upload-policies"),
    app.request("/api/v1/settings/upload-policies/upload-policy-stub"),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:read" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.detail.read",
    "settings.channel_map_assignment_plans.read",
    "settings.channel_map_assignments.read",
    "settings.channel_map_templates.detail.read",
    "settings.channel_map_templates.read",
    "settings.recording_profiles.detail.read",
    "settings.recording_profiles.read",
    "settings.upload_policies.detail.read",
    "settings.upload_policies.read",
    "settings.upload_providers.detail.read",
    "settings.upload_providers.read",
    "settings.watchdog_policies.detail.read",
    "settings.watchdog_policies.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.ok(deniedEvents.every((event) => event.target.type === "settings"));
});

test("settings detail routes return individual settings resources", async () => {
  const app = new Hono<AppBindings>();
  const currentUser = viewer(["settings:read"]);
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const uploadProviderStore = createUploadProviderStore();
  const template = await settingsStore.createChannelMapTemplate({
    channelMode: "mono_to_stereo_mix",
    entries: [
      {
        included: true,
        label: "Detail Channel",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    id: `channel_map_detail_${randomUUID()}`,
    name: "Detail Channel Map",
    tags: ["detail"],
  });
  const plan = await channelMapAssignmentPlanStore.create({
    targets: [{ targetId: "node_detail", targetType: "node" }],
    templateId: template.id,
  });
  const uploadPolicy = await createUploadPolicy({
    enabled: true,
    id: `upload-policy-detail-${randomUUID()}`,
    maxAttempts: 3,
    name: "Detail Upload Policy",
    provider: "stub",
    target: "stub://detail",
    trigger: "manual",
  });

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    requirePermission: allowPermission(),
    settingsStore,
    uploadProviderStore,
  });

  const profile = await jsonData(app, "/api/v1/settings/recording-profiles/voice-mp3-vbr");
  const watchdog = await jsonData(
    app,
    "/api/v1/settings/watchdog-policies/scheduled-voice-watchdog",
  );
  const templateDetail = await jsonData(
    app,
    `/api/v1/settings/channel-map-templates/${template.id}`,
  );
  const planDetail = await jsonData(
    app,
    `/api/v1/settings/channel-map-assignment-plans/${plan.id}`,
  );
  const provider = await jsonData(app, "/api/v1/settings/upload-providers/stub");
  const policy = await jsonData(app, `/api/v1/settings/upload-policies/${uploadPolicy.id}`);
  const missingProfile = await app.request("/api/v1/settings/recording-profiles/profile_missing");
  const missingTemplate = await app.request(
    "/api/v1/settings/channel-map-templates/template_missing",
  );
  const missingProvider = await app.request("/api/v1/settings/upload-providers/not-a-provider");

  assert.equal(profile.id, "voice-mp3-vbr");
  assert.equal(watchdog.id, "scheduled-voice-watchdog");
  assert.equal(templateDetail.id, template.id);
  assert.equal(planDetail.id, plan.id);
  assert.equal(provider.provider, "stub");
  assert.equal(policy.id, uploadPolicy.id);
  assert.equal(missingProfile.status, 404);
  assert.equal(missingTemplate.status, 404);
  assert.equal(missingProvider.status, 404);
});

test("settings manage routes update operational templates and audit snapshots", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const uploadProviderStore = createUploadProviderStore();
  const primaryTemplateId = `channel_map_ops_${randomUUID()}`;
  const rollbackTemplateId = `channel_map_rollback_${randomUUID()}`;
  const uploadPolicyId = `upload-policy-ops-${randomUUID()}`;

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore,
    uploadProviderStore,
  });

  const profileResponse = await requestJson(
    app,
    "/api/v1/settings/recording-profiles/voice-mp3-vbr",
    "PATCH",
    {
      maxTrackSeconds: 900,
      name: "Operations Voice MP3",
    },
  );
  const watchdogResponse = await requestJson(
    app,
    "/api/v1/settings/watchdog-policies/scheduled-voice-watchdog",
    "PATCH",
    {
      broadbandNoiseScoreThreshold: 0.84,
      channelCorrelationMode: "alert_on_high",
      channelCorrelationThreshold: 0.97,
      clippingMode: "alert_on_clipping",
      flatlineMode: "alert_on_flatline",
      flatlineThresholdDbfs: -105,
      humScoreThreshold: 0.76,
      minCumulativeChannelCorrelationSeconds: 15,
      minCumulativeClippingSeconds: 2,
      minCumulativeFlatlineSeconds: 12,
      minCumulativeQualitySeconds: 18,
      minSpeechScore: 0.65,
      name: "Operations Voice Watchdog",
      noiseScoreThreshold: 0.88,
      qualityAlertMode: "alert_on_noise_hum_static",
      qualityMode: "speech_required",
      staticScoreThreshold: 0.79,
    },
  );
  const providerResponse = await requestJson(
    app,
    "/api/v1/settings/upload-providers/stub",
    "PATCH",
    {
      displayName: "Operations Stub",
      enabled: true,
      target: "stub://operations",
    },
  );
  const uploadCreateResponse = await requestJson(app, "/api/v1/settings/upload-policies", "POST", {
    enabled: true,
    id: uploadPolicyId,
    maxAttempts: 4,
    name: "Operations Upload",
    provider: "stub",
    target: "stub://operations",
    trigger: "manual",
  });
  const uploadUpdateResponse = await requestJson(
    app,
    `/api/v1/settings/upload-policies/${uploadPolicyId}`,
    "PATCH",
    {
      deleteCacheAfterUpload: true,
      maxAttempts: 6,
    },
  );
  const templateCreateResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-templates",
    "POST",
    channelMapInput(primaryTemplateId, "Operations Primary Map"),
  );
  const templateUpdateResponse = await requestJson(
    app,
    `/api/v1/settings/channel-map-templates/${primaryTemplateId}`,
    "PATCH",
    {
      name: "Operations Primary Map Rev 2",
      tags: ["voice", "ops"],
    },
  );
  await requestJson(
    app,
    "/api/v1/settings/channel-map-templates",
    "POST",
    channelMapInput(rollbackTemplateId, "Operations Rollback Map"),
  );
  const assignmentResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments",
    "PUT",
    {
      targetId: "node_ops_room",
      targetType: "node",
      templateId: primaryTemplateId,
    },
  );
  const reassignmentResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments",
    "PUT",
    {
      targetId: "node_ops_room",
      targetType: "node",
      templateId: rollbackTemplateId,
    },
  );
  const bulkAssignmentResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments/bulk",
    "PUT",
    {
      targets: [
        { targetId: "node_ops_bulk", targetType: "node" },
        { targetId: "interface_ops_1", targetType: "interface" },
        { targetId: "interface_ops_1", targetType: "interface" },
      ],
      templateId: rollbackTemplateId,
    },
  );
  const planCreateResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignment-plans",
    "POST",
    {
      note: "Stage council room rollout",
      targets: [
        { targetId: "node_plan_room", targetType: "node" },
        { targetId: "interface_plan_1", targetType: "interface" },
        { targetId: "interface_plan_1", targetType: "interface" },
      ],
      templateId: primaryTemplateId,
    },
  );
  const planCreateBody = (await planCreateResponse.json()) as {
    data: { id: string; status: string; targets: Array<{ targetId: string }> };
  };
  const planApplyResponse = await app.request(
    `/api/v1/settings/channel-map-assignment-plans/${planCreateBody.data.id}/apply`,
    {
      method: "POST",
    },
  );
  const planApplyAgainResponse = await app.request(
    `/api/v1/settings/channel-map-assignment-plans/${planCreateBody.data.id}/apply`,
    {
      method: "POST",
    },
  );
  const rollbackResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments/rollback",
    "POST",
    {
      targetId: "node_ops_room",
      targetType: "node",
    },
  );
  const audits = await auditStore.list({ outcome: "succeeded", permission: "settings:manage" });

  assert.equal(profileResponse.status, 200);
  assert.equal(watchdogResponse.status, 200);
  assert.equal(providerResponse.status, 200);
  assert.equal(uploadCreateResponse.status, 201);
  assert.equal(uploadUpdateResponse.status, 200);
  assert.equal(templateCreateResponse.status, 201);
  assert.equal(templateUpdateResponse.status, 200);
  assert.equal(assignmentResponse.status, 200);
  assert.equal(reassignmentResponse.status, 200);
  assert.equal(bulkAssignmentResponse.status, 200);
  assert.equal(planCreateResponse.status, 201);
  assert.equal(planApplyResponse.status, 200);
  assert.equal(planApplyAgainResponse.status, 409);
  assert.equal(rollbackResponse.status, 200);

  const updatedTemplate = (await templateUpdateResponse.json()) as { data: { revision: number } };
  const reassignment = (await reassignmentResponse.json()) as {
    data: { history: Array<{ previousTemplateId?: string }>; templateId: string };
  };
  const bulkAssignment = (await bulkAssignmentResponse.json()) as {
    data: Array<{ targetId: string; targetType: string; templateId: string }>;
  };
  const planApply = (await planApplyResponse.json()) as {
    data: {
      assignments: Array<{ targetId: string; targetType: string; templateId: string }>;
      plan: { status: string };
    };
  };
  const rollback = (await rollbackResponse.json()) as { data: { templateId: string } };

  assert.equal(updatedTemplate.data.revision, 2);
  assert.equal(reassignment.data.templateId, rollbackTemplateId);
  assert.equal(reassignment.data.history.at(-1)?.previousTemplateId, primaryTemplateId);
  assert.deepEqual(
    bulkAssignment.data.map((assignment) => `${assignment.targetType}:${assignment.targetId}`),
    ["node:node_ops_bulk", "interface:interface_ops_1"],
  );
  assert.ok(
    bulkAssignment.data.every((assignment) => assignment.templateId === rollbackTemplateId),
  );
  assert.equal(planCreateBody.data.status, "pending");
  assert.deepEqual(
    planCreateBody.data.targets.map((target) => target.targetId),
    ["node_plan_room", "interface_plan_1"],
  );
  assert.equal(planApply.data.plan.status, "applied");
  assert.deepEqual(
    planApply.data.assignments.map(
      (assignment) => `${assignment.targetType}:${assignment.targetId}`,
    ),
    ["node:node_plan_room", "interface:interface_plan_1"],
  );
  assert.ok(
    planApply.data.assignments.every((assignment) => assignment.templateId === primaryTemplateId),
  );
  assert.equal(rollback.data.templateId, primaryTemplateId);
  assert.deepEqual(audits.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.apply.succeeded",
    "settings.channel_map_assignment_plans.create.succeeded",
    "settings.channel_map_assignments.bulk_update.succeeded",
    "settings.channel_map_assignments.rollback.succeeded",
    "settings.channel_map_assignments.update.succeeded",
    "settings.channel_map_assignments.update.succeeded",
    "settings.channel_map_templates.create.succeeded",
    "settings.channel_map_templates.create.succeeded",
    "settings.channel_map_templates.update.succeeded",
    "settings.recording_profiles.update.succeeded",
    "settings.upload_policies.create.succeeded",
    "settings.upload_policies.update.succeeded",
    "settings.upload_providers.update.succeeded",
    "settings.watchdog_policies.update.succeeded",
  ]);

  const profileAudit = audits.find(
    (event) => event.action === "settings.recording_profiles.update.succeeded",
  );

  assert.equal(profileAudit?.before?.name, "Voice MP3 VBR");
  assert.equal(profileAudit?.after?.name, "Operations Voice MP3");
  const watchdogAudit = audits.find(
    (event) =>
      event.action === "settings.watchdog_policies.update.succeeded" &&
      event.after?.name === "Operations Voice Watchdog",
  );

  assert.equal(watchdogAudit?.after?.channelCorrelationMode, "alert_on_high");
  assert.equal(watchdogAudit?.after?.broadbandNoiseScoreThreshold, 0.84);
  assert.equal(watchdogAudit?.after?.channelCorrelationThreshold, 0.97);
  assert.equal(watchdogAudit?.after?.clippingMode, "alert_on_clipping");
  assert.equal(watchdogAudit?.after?.flatlineMode, "alert_on_flatline");
  assert.equal(watchdogAudit?.after?.flatlineThresholdDbfs, -105);
  assert.equal(watchdogAudit?.after?.humScoreThreshold, 0.76);
  assert.equal(watchdogAudit?.after?.minCumulativeChannelCorrelationSeconds, 15);
  assert.equal(watchdogAudit?.after?.minCumulativeClippingSeconds, 2);
  assert.equal(watchdogAudit?.after?.minCumulativeFlatlineSeconds, 12);
  assert.equal(watchdogAudit?.after?.minCumulativeQualitySeconds, 18);
  assert.equal(watchdogAudit?.after?.noiseScoreThreshold, 0.88);
  assert.equal(watchdogAudit?.after?.qualityAlertMode, "alert_on_noise_hum_static");
  assert.equal(watchdogAudit?.after?.staticScoreThreshold, 0.79);
  const bulkAudit = audits.find(
    (event) => event.action === "settings.channel_map_assignments.bulk_update.succeeded",
  );

  assert.equal(bulkAudit?.after?.targetCount, 2);
  assert.equal(bulkAudit?.target.type, "channel_map_assignment_collection");
  const planApplyAudit = audits.find(
    (event) => event.action === "settings.channel_map_assignment_plans.apply.succeeded",
  );

  assert.equal(planApplyAudit?.before?.status, "pending");
  assert.equal(planApplyAudit?.after?.plan.status, "applied");
  assert.equal(planApplyAudit?.after?.targetCount, 2);
});

function requestJson(
  app: Hono<AppBindings>,
  path: string,
  method: "PATCH" | "POST" | "PUT",
  body: Record<string, unknown>,
) {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

async function jsonData(app: Hono<AppBindings>, path: string) {
  const response = await app.request(path);
  const body = (await response.json()) as { data: Record<string, unknown> };

  assert.equal(response.status, 200);

  return body.data;
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
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
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
    email: "settings-viewer@example.com",
    groups: [],
    id: "user_settings_viewer_test",
    name: "Settings Viewer Test",
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
        label: "Podium Mic",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    id,
    name,
    tags: ["voice"],
  };
}
