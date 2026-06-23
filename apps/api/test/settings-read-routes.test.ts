import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const settingsReadRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-read-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  settingsReadRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_PLAN_STORE_PATH = path.join(
  settingsReadRoot,
  "channel-map-assignment-plans.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  settingsReadRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(settingsReadRoot, "profiles.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(settingsReadRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(settingsReadRoot, "upload-providers.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(
  settingsReadRoot,
  "watchdog-policies.json",
);

const { createAuditStore } = await import("../src/audit-store.js");
const { createChannelMapAssignmentPlanStore } =
  await import("../src/channel-map-assignment-plans.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { createUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadProviderStore } = await import("../src/upload-providers.js");

test.after(async () => {
  await rm(settingsReadRoot, { force: true, recursive: true });
});

test("settings list read routes audit visible resource counts", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const uploadProviderStore = createUploadProviderStore();
  const template = await settingsStore.createChannelMapTemplate({
    channelMode: "mono_to_stereo_mix",
    entries: [
      {
        included: true,
        label: "List Channel",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    id: `channel_map_list_${randomUUID()}`,
    name: "List Channel Map",
    tags: ["list"],
  });
  await settingsStore.assignChannelMapTemplate({
    targetId: "node_list",
    targetType: "node",
    templateId: template.id,
  });
  await channelMapAssignmentPlanStore.create({
    targets: [{ targetId: "node_list", targetType: "node" }],
    templateId: template.id,
  });
  await createUploadPolicy({
    enabled: true,
    id: `upload-policy-list-${randomUUID()}`,
    maxAttempts: 3,
    name: "List Upload Policy",
    provider: "stub",
    target: "stub://list",
    trigger: "manual",
  });

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore,
    uploadProviderStore,
  });

  const paths = [
    "/api/v1/settings/recording-profiles",
    "/api/v1/settings/watchdog-policies",
    "/api/v1/settings/channel-map-templates",
    "/api/v1/settings/channel-map-assignments",
    "/api/v1/settings/channel-map-assignment-plans",
    "/api/v1/settings/upload-providers",
    "/api/v1/settings/upload-policies",
  ];
  const responses = await Promise.all(paths.map((routePath) => app.request(routePath)));
  const bodies = await Promise.all(
    responses.map((response) => response.json() as Promise<{ data: unknown[] }>),
  );
  const audits = await auditStore.list({ outcome: "succeeded", permission: "settings:read" });

  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(audits.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.read.succeeded",
    "settings.channel_map_assignments.read.succeeded",
    "settings.channel_map_templates.read.succeeded",
    "settings.recording_profiles.read.succeeded",
    "settings.upload_policies.read.succeeded",
    "settings.upload_providers.read.succeeded",
    "settings.watchdog_policies.read.succeeded",
  ]);
  assert.deepEqual(
    audits.map((event) => `${event.action}:${event.details.returnedCount}`).sort(),
    [
      `settings.channel_map_assignment_plans.read.succeeded:${bodies[4]?.data.length}`,
      `settings.channel_map_assignments.read.succeeded:${bodies[3]?.data.length}`,
      `settings.channel_map_templates.read.succeeded:${bodies[2]?.data.length}`,
      `settings.recording_profiles.read.succeeded:${bodies[0]?.data.length}`,
      `settings.upload_policies.read.succeeded:${bodies[6]?.data.length}`,
      `settings.upload_providers.read.succeeded:${bodies[5]?.data.length}`,
      `settings.watchdog_policies.read.succeeded:${bodies[1]?.data.length}`,
    ].sort(),
  );
  assert.ok(audits.every((event) => event.target.type === "settings"));
});

test("settings detail read routes audit successes and missing resources", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
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
    id: `channel_map_detail_audit_${randomUUID()}`,
    name: "Detail Audit Channel Map",
    tags: ["detail"],
  });
  const plan = await channelMapAssignmentPlanStore.create({
    targets: [{ targetId: "node_detail_audit", targetType: "node" }],
    templateId: template.id,
  });
  const uploadPolicy = await createUploadPolicy({
    enabled: true,
    id: `upload-policy-detail-audit-${randomUUID()}`,
    maxAttempts: 3,
    name: "Detail Audit Upload Policy",
    provider: "stub",
    target: "stub://detail-audit",
    trigger: "manual",
  });

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore,
    uploadProviderStore,
  });

  const successResponses = await Promise.all([
    app.request("/api/v1/settings/recording-profiles/voice-mp3-vbr"),
    app.request("/api/v1/settings/watchdog-policies/scheduled-voice-watchdog"),
    app.request(`/api/v1/settings/channel-map-templates/${template.id}`),
    app.request(`/api/v1/settings/channel-map-assignment-plans/${plan.id}`),
    app.request("/api/v1/settings/upload-providers/stub"),
    app.request(`/api/v1/settings/upload-policies/${uploadPolicy.id}`),
  ]);
  const missingResponses = await Promise.all([
    app.request("/api/v1/settings/recording-profiles/profile_missing"),
    app.request("/api/v1/settings/watchdog-policies/policy_missing"),
    app.request("/api/v1/settings/channel-map-templates/template_missing"),
    app.request("/api/v1/settings/channel-map-assignment-plans/plan_missing"),
    app.request("/api/v1/settings/upload-providers/not-a-provider"),
    app.request("/api/v1/settings/upload-policies/policy_missing"),
  ]);
  const successAudits = await auditStore.list({
    outcome: "succeeded",
    permission: "settings:read",
  });
  const failedAudits = await auditStore.list({ outcome: "failed", permission: "settings:read" });

  assert.ok(successResponses.every((response) => response.status === 200));
  assert.ok(missingResponses.every((response) => response.status === 404));
  assert.deepEqual(successAudits.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.detail.read.succeeded",
    "settings.channel_map_templates.detail.read.succeeded",
    "settings.recording_profiles.detail.read.succeeded",
    "settings.upload_policies.detail.read.succeeded",
    "settings.upload_providers.detail.read.succeeded",
    "settings.watchdog_policies.detail.read.succeeded",
  ]);
  assert.deepEqual(failedAudits.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.detail.read.failed",
    "settings.channel_map_templates.detail.read.failed",
    "settings.recording_profiles.detail.read.failed",
    "settings.upload_policies.detail.read.failed",
    "settings.upload_providers.detail.read.failed",
    "settings.watchdog_policies.detail.read.failed",
  ]);
  assert.ok(successAudits.every((event) => event.target.id));
  assert.ok(failedAudits.every((event) => event.reason === "not_found"));
});

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
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

function viewer(): CurrentUser {
  return {
    email: "settings-read-viewer@example.com",
    groups: [],
    id: "user_settings_read_viewer_test",
    name: "Settings Read Viewer Test",
    permissions: ["settings:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
