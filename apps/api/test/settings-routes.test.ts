import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { AppBindings, AuditTarget } from "../src/http-types.js";
import {
  createAuditStore,
  createSettingsStore,
  createUploadDestinationStore,
  denyMissingPermission,
  denyResourceScope,
  recordAuditEvent,
  registerSettingsRoutes,
  requestJson,
  viewer,
} from "./settings-routes-harness.js";

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
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const responses = await Promise.all([
    requestJson(app, "/api/v1/settings/recording-profiles/voice-mp3-vbr", "PATCH", {
      name: "Blocked Profile",
    }),
    requestJson(app, "/api/v1/settings/watchdog-policies/scheduled-voice-watchdog", "PATCH", {
      name: "Blocked Watchdog",
    }),
    requestJson(app, "/api/v1/settings/upload-destinations/dest_blocked", "PATCH", {
      displayName: "Blocked Destination",
    }),
    requestJson(app, "/api/v1/settings/upload-policies", "POST", {
      enabled: true,
      maxAttempts: 1,
      name: "Blocked Upload Policy",
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
    requestJson(app, "/api/v1/settings/recording-profiles", "POST", {
      name: "Blocked Recording Profile",
    }),
    requestJson(app, "/api/v1/settings/watchdog-policies", "POST", {
      name: "Blocked Watchdog Policy",
    }),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:manage" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.apply",
    "settings.channel_map_assignment_plans.create",
    "settings.channel_map_assignments.bulk_update",
    "settings.channel_map_assignments.rollback",
    "settings.channel_map_assignments.update",
    "settings.channel_map_templates.create",
    "settings.channel_map_templates.update",
    "settings.recording_profiles.create",
    "settings.recording_profiles.update",
    "settings.upload_destinations.update",
    "settings.upload_policies.create",
    "settings.upload_policies.update",
    "settings.watchdog_policies.create",
    "settings.watchdog_policies.update",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.equal(
    deniedEvents.find((event) => event.action === "settings.recording_profiles.update")?.target
      .type,
    "recording_profile",
  );
  assert.equal(
    deniedEvents.find((event) => event.action === "settings.watchdog_policies.update")?.target.type,
    "watchdog_policy",
  );
  assert.equal(
    deniedEvents.find((event) => event.action === "settings.channel_map_templates.update")?.target
      .type,
    "channel_map_template",
  );
  assert.equal(
    deniedEvents.find((event) => event.action === "settings.upload_destinations.update")?.target
      .type,
    "upload_destination",
  );
  assert.equal(
    deniedEvents.find((event) => event.action === "settings.upload_policies.update")?.target.type,
    "upload_policy",
  );
  assert.equal(
    deniedEvents.find((event) => event.action === "settings.channel_map_assignment_plans.apply")
      ?.target.type,
    "channel_map_assignment_plan",
  );
  assert.ok(
    deniedEvents
      .filter(
        (event) =>
          ![
            "settings.channel_map_assignment_plans.apply",
            "settings.channel_map_templates.update",
            "settings.recording_profiles.update",
            "settings.upload_destinations.update",
            "settings.upload_policies.update",
            "settings.watchdog_policies.update",
          ].includes(event.action),
      )
      .every((event) => event.target.type === "settings"),
  );
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
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const responses = await Promise.all([
    app.request("/api/v1/settings/recording-profiles"),
    app.request("/api/v1/settings/recording-profiles/voice-mp3-vbr"),
    app.request("/api/v1/settings/recording-profiles/voice-mp3-vbr/actions"),
    app.request("/api/v1/settings/watchdog-policies"),
    app.request("/api/v1/settings/watchdog-policies/scheduled-voice-watchdog"),
    app.request("/api/v1/settings/watchdog-policies/scheduled-voice-watchdog/actions"),
    app.request("/api/v1/settings/channel-map-templates"),
    app.request("/api/v1/settings/channel-map-templates/template_missing"),
    app.request("/api/v1/settings/channel-map-templates/template_missing/actions"),
    app.request("/api/v1/settings/channel-map-assignments"),
    app.request("/api/v1/settings/channel-map-assignment-plans"),
    app.request("/api/v1/settings/channel-map-assignment-plans/plan_missing"),
    app.request("/api/v1/settings/channel-map-assignment-plans/plan_missing/actions"),
    app.request("/api/v1/settings/upload-destinations"),
    app.request("/api/v1/settings/upload-destinations/dest_x"),
    app.request("/api/v1/settings/upload-destinations/dest_x/actions"),
    app.request("/api/v1/settings/upload-policies"),
    app.request("/api/v1/settings/upload-policies/upload-policy-stub"),
    app.request("/api/v1/settings/upload-policies/upload-policy-stub/actions"),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:read" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.actions.read",
    "settings.channel_map_assignment_plans.detail.read",
    "settings.channel_map_assignment_plans.read",
    "settings.channel_map_assignments.read",
    "settings.channel_map_templates.actions.read",
    "settings.channel_map_templates.detail.read",
    "settings.channel_map_templates.read",
    "settings.recording_profiles.actions.read",
    "settings.recording_profiles.detail.read",
    "settings.recording_profiles.read",
    "settings.upload_destinations.actions.read",
    "settings.upload_destinations.detail.read",
    "settings.upload_destinations.read",
    "settings.upload_policies.actions.read",
    "settings.upload_policies.detail.read",
    "settings.upload_policies.read",
    "settings.watchdog_policies.actions.read",
    "settings.watchdog_policies.detail.read",
    "settings.watchdog_policies.read",
  ]);
  assert.ok(deniedEvents.every((event) => event.reason === "missing_permission"));
  assert.deepEqual([...new Set(deniedEvents.map((event) => event.target.type))].sort(), [
    "channel_map_assignment_plan",
    "channel_map_template",
    "recording_profile",
    "settings",
    "upload_destination",
    "upload_policy",
    "watchdog_policy",
  ]);
});

test("recording profile routes honor resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const settingsStore = createSettingsStore();
  const hiddenProfileId = "voice-mp3-vbr";
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "recording_profile" && target.id === hiddenProfileId);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore,
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const listResponse = await app.request("/api/v1/settings/recording-profiles");
  const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
  const detailResponse = await app.request(
    `/api/v1/settings/recording-profiles/${hiddenProfileId}`,
  );
  const actionsResponse = await app.request(
    `/api/v1/settings/recording-profiles/${hiddenProfileId}/actions`,
  );
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/recording-profiles/${hiddenProfileId}`,
    "PATCH",
    { name: "Hidden Profile Update" },
  );
  const deniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:read",
  });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedProfile = await settingsStore.findRecordingProfile(hiddenProfileId);

  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.data.some((profile) => profile.id === hiddenProfileId),
    false,
  );
  assert.equal(detailResponse.status, 403);
  assert.equal(actionsResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(storedProfile?.name, "Voice MP3 VBR");
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.recording_profiles.actions.read",
    "settings.recording_profiles.detail.read",
  ]);
  assert.equal(manageDeniedEvents[0]?.action, "settings.recording_profiles.update");
  assert.ok(
    [...deniedEvents, ...manageDeniedEvents].every(
      (event) =>
        event.reason === "access_policy_denied" &&
        event.target.id === hiddenProfileId &&
        event.target.type === "recording_profile",
    ),
  );
});

test("watchdog policy routes honor resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const settingsStore = createSettingsStore();
  const hiddenPolicyId = "scheduled-voice-watchdog";
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "watchdog_policy" && target.id === hiddenPolicyId);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore,
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const listResponse = await app.request("/api/v1/settings/watchdog-policies");
  const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
  const detailResponse = await app.request(`/api/v1/settings/watchdog-policies/${hiddenPolicyId}`);
  const actionsResponse = await app.request(
    `/api/v1/settings/watchdog-policies/${hiddenPolicyId}/actions`,
  );
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/watchdog-policies/${hiddenPolicyId}`,
    "PATCH",
    { name: "Hidden Watchdog Update", thresholdDbfs: -12 },
  );
  const deniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:read",
  });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedPolicy = await settingsStore.findWatchdogPolicy(hiddenPolicyId);

  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.data.some((policy) => policy.id === hiddenPolicyId),
    false,
  );
  assert.equal(detailResponse.status, 403);
  assert.equal(actionsResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(storedPolicy?.name, "Scheduled Voice Watchdog");
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.watchdog_policies.actions.read",
    "settings.watchdog_policies.detail.read",
  ]);
  assert.equal(manageDeniedEvents[0]?.action, "settings.watchdog_policies.update");
  assert.ok(
    [...deniedEvents, ...manageDeniedEvents].every(
      (event) =>
        event.reason === "access_policy_denied" &&
        event.target.id === hiddenPolicyId &&
        event.target.type === "watchdog_policy",
    ),
  );
});

test("channel map template routes honor resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const settingsStore = createSettingsStore();
  const hiddenTemplate = await settingsStore.createChannelMapTemplate({
    channelMode: "mono_to_stereo_mix",
    entries: [
      {
        included: true,
        label: "Hidden Channel",
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    id: `channel_map_hidden_${randomUUID()}`,
    name: "Hidden Channel Map",
    tags: ["hidden"],
  });
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "channel_map_template" && target.id === hiddenTemplate.id);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore,
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const listResponse = await app.request("/api/v1/settings/channel-map-templates");
  const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
  const detailResponse = await app.request(
    `/api/v1/settings/channel-map-templates/${hiddenTemplate.id}`,
  );
  const actionsResponse = await app.request(
    `/api/v1/settings/channel-map-templates/${hiddenTemplate.id}/actions`,
  );
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/channel-map-templates/${hiddenTemplate.id}`,
    "PATCH",
    { name: "Hidden Channel Map Update" },
  );
  const deniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:read",
  });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedTemplate = await settingsStore.findChannelMapTemplate(hiddenTemplate.id);

  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.data.some((template) => template.id === hiddenTemplate.id),
    false,
  );
  assert.equal(detailResponse.status, 403);
  assert.equal(actionsResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(storedTemplate?.name, "Hidden Channel Map");
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_templates.actions.read",
    "settings.channel_map_templates.detail.read",
  ]);
  assert.equal(manageDeniedEvents[0]?.action, "settings.channel_map_templates.update");
  assert.ok(
    [...deniedEvents, ...manageDeniedEvents].every(
      (event) =>
        event.reason === "access_policy_denied" &&
        event.target.id === hiddenTemplate.id &&
        event.target.type === "channel_map_template",
    ),
  );
});
