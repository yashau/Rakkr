import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AppBindings } from "../src/http-types.js";
import {
  allowPermission,
  channelMapInput,
  createAuditStore,
  createChannelMapAssignmentPlanStore,
  createSettingsStore,
  createUploadDestinationStore,
  createUploadPolicy,
  jsonData,
  recordAuditEvent,
  registerSettingsRoutes,
  requestJson,
  viewer,
} from "./settings-routes-harness.js";

test("settings detail routes return individual settings resources", async () => {
  const app = new Hono<AppBindings>();
  const currentUser = viewer(["settings:read"]);
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const uploadDestinationStore = createUploadDestinationStore();
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
    trigger: "manual",
  });
  const uploadDestination = await uploadDestinationStore.create({
    displayName: "Detail Destination",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    recordAuditEvent: recordAuditEvent(createAuditStore("")),
    requirePermission: allowPermission(),
    settingsStore,
    uploadDestinationStore,
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
  const destination = await jsonData(
    app,
    `/api/v1/settings/upload-destinations/${uploadDestination.id}`,
  );
  const policy = await jsonData(app, `/api/v1/settings/upload-policies/${uploadPolicy.id}`);
  const missingProfile = await app.request("/api/v1/settings/recording-profiles/profile_missing");
  const missingTemplate = await app.request(
    "/api/v1/settings/channel-map-templates/template_missing",
  );
  const missingDestination = await app.request(
    "/api/v1/settings/upload-destinations/destination_missing",
  );

  assert.equal(profile.id, "voice-mp3-vbr");
  assert.equal(watchdog.id, "scheduled-voice-watchdog");
  assert.equal(templateDetail.id, template.id);
  assert.equal(planDetail.id, plan.id);
  assert.equal(destination.id, uploadDestination.id);
  assert.equal(policy.id, uploadPolicy.id);
  assert.equal(missingProfile.status, 404);
  assert.equal(missingTemplate.status, 404);
  assert.equal(missingDestination.status, 404);
});

test("settings manage routes update operational templates and audit snapshots", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const uploadDestinationStore = createUploadDestinationStore();
  const primaryTemplateId = `channel_map_ops_${randomUUID()}`;
  const rollbackTemplateId = `channel_map_rollback_${randomUUID()}`;
  const uploadPolicyId = `upload-policy-ops-${randomUUID()}`;
  const uploadDestination = await uploadDestinationStore.create({
    displayName: "Operations Destination",
    enabled: true,
    kind: "smb",
    smb: { server: "ops.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore,
    uploadDestinationStore,
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
  const uploadCreateResponse = await requestJson(app, "/api/v1/settings/upload-policies", "POST", {
    destinationId: uploadDestination.id,
    enabled: true,
    id: uploadPolicyId,
    maxAttempts: 4,
    name: "Operations Upload",
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
  await requestJson(app, "/api/v1/settings/recording-profiles", "POST", {
    name: "Created Recording Profile",
  });
  await requestJson(app, "/api/v1/settings/watchdog-policies", "POST", {
    name: "Created Watchdog Policy",
  });
  const audits = await auditStore.list({ outcome: "succeeded", permission: "settings:manage" });

  assert.equal(profileResponse.status, 200);
  assert.equal(watchdogResponse.status, 200);
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
    "settings.recording_profiles.create.succeeded",
    "settings.recording_profiles.update.succeeded",
    "settings.upload_policies.create.succeeded",
    "settings.upload_policies.update.succeeded",
    "settings.watchdog_policies.create.succeeded",
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
