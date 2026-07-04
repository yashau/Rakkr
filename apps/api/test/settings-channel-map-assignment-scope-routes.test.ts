import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "../src/http-types.js";

const scopeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-assignment-scope-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  scopeRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_PLAN_STORE_PATH = path.join(
  scopeRoot,
  "channel-map-assignment-plans.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  scopeRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(scopeRoot, "profiles.json");
process.env.RAKKR_UPLOAD_POLICY_STORE_PATH = path.join(scopeRoot, "upload-policies.json");
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(scopeRoot, "upload-providers.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(scopeRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createChannelMapAssignmentPlanStore } =
  await import("../src/channel-map-assignment-plans.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");

test.after(async () => {
  await rm(scopeRoot, { force: true, recursive: true });
});

test("channel map assignment routes honor target resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const primaryTemplate = await settingsStore.createChannelMapTemplate(
    channelMapInput("Primary Scope Map"),
  );
  const rollbackTemplate = await settingsStore.createChannelMapTemplate(
    channelMapInput("Rollback Scope Map"),
  );
  const visibleNodeId = `node_visible_assignment_${randomUUID()}`;
  const hiddenNodeId = `node_hidden_assignment_${randomUUID()}`;
  const hiddenRollbackNodeId = `node_hidden_rollback_${randomUUID()}`;
  const hiddenPlanNodeId = `node_hidden_plan_${randomUUID()}`;
  const visiblePlanNodeId = `node_visible_plan_${randomUUID()}`;
  const hiddenNewNodeId = `node_hidden_new_${randomUUID()}`;
  const visibleBulkNodeId = `node_visible_bulk_${randomUUID()}`;
  const hiddenBulkNodeId = `node_hidden_bulk_${randomUUID()}`;
  const hiddenPlanCreateNodeId = `node_hidden_plan_create_${randomUUID()}`;
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "node" && target.id?.startsWith("node_hidden_"));

  const visibleAssignment = await settingsStore.assignChannelMapTemplate({
    targetId: visibleNodeId,
    targetType: "node",
    templateId: primaryTemplate.id,
  });
  const hiddenAssignment = await settingsStore.assignChannelMapTemplate({
    targetId: hiddenNodeId,
    targetType: "node",
    templateId: primaryTemplate.id,
  });
  await settingsStore.assignChannelMapTemplate({
    targetId: hiddenRollbackNodeId,
    targetType: "node",
    templateId: primaryTemplate.id,
  });
  await settingsStore.assignChannelMapTemplate({
    targetId: hiddenRollbackNodeId,
    targetType: "node",
    templateId: rollbackTemplate.id,
  });
  const hiddenPlan = await channelMapAssignmentPlanStore.create({
    targets: [{ targetId: hiddenPlanNodeId, targetType: "node" }],
    templateId: primaryTemplate.id,
  });
  const visiblePlan = await channelMapAssignmentPlanStore.create({
    targets: [{ targetId: visiblePlanNodeId, targetType: "node" }],
    templateId: primaryTemplate.id,
  });

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore,
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const assignmentsResponse = await app.request("/api/v1/settings/channel-map-assignments");
  const assignmentsBody = (await assignmentsResponse.json()) as {
    data: Array<{ id: string; targetId: string }>;
  };
  const plansResponse = await app.request("/api/v1/settings/channel-map-assignment-plans");
  const plansBody = (await plansResponse.json()) as { data: Array<{ id: string }> };
  const hiddenPlanDetailResponse = await app.request(
    `/api/v1/settings/channel-map-assignment-plans/${hiddenPlan.id}`,
  );
  const hiddenPlanActionsResponse = await app.request(
    `/api/v1/settings/channel-map-assignment-plans/${hiddenPlan.id}/actions`,
  );
  const hiddenAssignResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments",
    "PUT",
    { targetId: hiddenNewNodeId, targetType: "node", templateId: primaryTemplate.id },
  );
  const hiddenBulkResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments/bulk",
    "PUT",
    {
      targets: [
        { targetId: visibleBulkNodeId, targetType: "node" },
        { targetId: hiddenBulkNodeId, targetType: "node" },
      ],
      templateId: primaryTemplate.id,
    },
  );
  const hiddenPlanCreateResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignment-plans",
    "POST",
    {
      targets: [{ targetId: hiddenPlanCreateNodeId, targetType: "node" }],
      templateId: primaryTemplate.id,
    },
  );
  const hiddenPlanApplyResponse = await app.request(
    `/api/v1/settings/channel-map-assignment-plans/${hiddenPlan.id}/apply`,
    { method: "POST" },
  );
  const hiddenRollbackResponse = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments/rollback",
    "POST",
    { targetId: hiddenRollbackNodeId, targetType: "node" },
  );
  const readDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:read",
  });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedAssignments = await settingsStore.listChannelMapAssignments();
  const storedRollbackAssignment = storedAssignments.find(
    (assignment) => assignment.targetId === hiddenRollbackNodeId,
  );
  const storedPlans = await channelMapAssignmentPlanStore.list();

  assert.equal(assignmentsResponse.status, 200);
  assert.equal(plansResponse.status, 200);
  assert.equal(
    assignmentsBody.data.some((assignment) => assignment.id === visibleAssignment.id),
    true,
  );
  assert.equal(
    assignmentsBody.data.some((assignment) => assignment.id === hiddenAssignment.id),
    false,
  );
  assert.equal(
    plansBody.data.some((plan) => plan.id === visiblePlan.id),
    true,
  );
  assert.equal(
    plansBody.data.some((plan) => plan.id === hiddenPlan.id),
    false,
  );
  assert.equal(hiddenPlanDetailResponse.status, 403);
  assert.equal(hiddenPlanActionsResponse.status, 403);
  assert.equal(hiddenAssignResponse.status, 403);
  assert.equal(hiddenBulkResponse.status, 403);
  assert.equal(hiddenPlanCreateResponse.status, 403);
  assert.equal(hiddenPlanApplyResponse.status, 403);
  assert.equal(hiddenRollbackResponse.status, 403);
  assert.equal(
    storedAssignments.some((assignment) => assignment.targetId === hiddenNewNodeId),
    false,
  );
  assert.equal(
    storedAssignments.some((assignment) => assignment.targetId === visibleBulkNodeId),
    false,
  );
  assert.equal(storedRollbackAssignment?.templateId, rollbackTemplate.id);
  assert.equal(
    storedPlans.some((plan) =>
      plan.targets.some((target) => target.targetId === hiddenPlanCreateNodeId),
    ),
    false,
  );
  assert.deepEqual(readDeniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.actions.read",
    "settings.channel_map_assignment_plans.detail.read",
  ]);
  assert.deepEqual(manageDeniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.apply",
    "settings.channel_map_assignment_plans.create.failed",
    "settings.channel_map_assignments.bulk_update.failed",
    "settings.channel_map_assignments.rollback.failed",
    "settings.channel_map_assignments.update.failed",
  ]);
  assert.ok(
    [...readDeniedEvents, ...manageDeniedEvents].every(
      (event) => event.target.type === "node" && event.target.id?.startsWith("node_hidden_"),
    ),
  );
});

test("channel map assignment routes reject binding a scope-denied template", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();
  const visibleTemplate = await settingsStore.createChannelMapTemplate(
    channelMapInput("Visible Template"),
  );
  const hiddenTemplate = await settingsStore.createChannelMapTemplate(
    channelMapInput("Hidden Template"),
  );
  // Only the hidden TEMPLATE is scoped out; all nodes/targets stay visible so the
  // denial can only come from the template scope check, not the target check.
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "channel_map_template" && target.id === hiddenTemplate.id);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore,
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const assignHidden = await requestJson(app, "/api/v1/settings/channel-map-assignments", "PUT", {
    targetId: "node_assign_visible",
    targetType: "node",
    templateId: hiddenTemplate.id,
  });
  const bulkHidden = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignments/bulk",
    "PUT",
    {
      targets: [{ targetId: "node_bulk_visible", targetType: "node" }],
      templateId: hiddenTemplate.id,
    },
  );
  const planHidden = await requestJson(
    app,
    "/api/v1/settings/channel-map-assignment-plans",
    "POST",
    {
      targets: [{ targetId: "node_plan_visible", targetType: "node" }],
      templateId: hiddenTemplate.id,
    },
  );
  const assignVisible = await requestJson(app, "/api/v1/settings/channel-map-assignments", "PUT", {
    targetId: "node_assign_ok",
    targetType: "node",
    templateId: visibleTemplate.id,
  });
  const storedAssignments = await settingsStore.listChannelMapAssignments();
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });

  assert.equal(assignHidden.status, 403);
  assert.equal(bulkHidden.status, 403);
  assert.equal(planHidden.status, 403);
  assert.equal(assignVisible.status, 200);
  assert.equal(
    storedAssignments.some((assignment) => assignment.templateId === hiddenTemplate.id),
    false,
    "a scope-denied template must not be bound to any target",
  );
  assert.deepEqual(manageDeniedEvents.map((event) => event.action).sort(), [
    "settings.channel_map_assignment_plans.create.failed",
    "settings.channel_map_assignments.bulk_update.failed",
    "settings.channel_map_assignments.update.failed",
  ]);
  assert.ok(
    manageDeniedEvents.every(
      (event) =>
        event.target.type === "channel_map_template" && event.target.id === hiddenTemplate.id,
    ),
  );
});

test("R28: channel map template create with a duplicate id is a 409 and does not overwrite", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const settingsStore = createSettingsStore();
  const channelMapAssignmentPlanStore = createChannelMapAssignmentPlanStore();

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    channelMapAssignmentPlanStore,
    hasResourceScope: async () => true,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, () => true),
    settingsStore,
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const templateId = `channel_map_dup_${randomUUID()}`;
  const original = { ...channelMapInput("Original Template"), id: templateId };
  const impostor = { ...channelMapInput("Impostor Template"), id: templateId };
  const first = await requestJson(app, "/api/v1/settings/channel-map-templates", "POST", original);
  const conflict = await requestJson(
    app,
    "/api/v1/settings/channel-map-templates",
    "POST",
    impostor,
  );
  const conflictBody = (await conflict.json()) as { reason?: string };
  const stored = await settingsStore.findChannelMapTemplate(templateId);
  const failed = await auditStore.list({
    action: "settings.channel_map_templates.create.failed",
  });

  assert.equal(first.status, 201);
  assert.equal(conflict.status, 409);
  assert.equal(conflictBody.reason, "channel_map_template_exists");
  // The create must not have overwritten the original template or reset its revision.
  assert.equal(stored?.name, "Original Template");
  assert.equal(stored?.revision, 1);
  assert.equal(failed.at(-1)?.reason, "channel_map_template_exists");
});

function channelMapInput(name: string) {
  return {
    channelMode: "mono_to_stereo_mix" as const,
    entries: [
      {
        included: true,
        label: name,
        outputChannelIndex: 1,
        sourceChannelIndex: 1,
      },
    ],
    id: `channel_map_assignment_scope_${randomUUID()}`,
    name,
    tags: ["scope"],
  };
}

function requestJson(
  app: Hono<AppBindings>,
  url: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
) {
  return app.request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function denyResourceScope(
  auditStore: ReturnType<typeof createAuditStore>,
  currentUser: CurrentUser,
  isVisibleTarget: (target: AuditTarget) => boolean,
): RequirePermission {
  return (permission, action, target) => async (c, next) => {
    const auditTarget = target ? await target(c) : { type: "controller" as const };
    const allowed = currentUser.permissions.includes(permission) && isVisibleTarget(auditTarget);

    await recordAuditEvent(auditStore)(c, {
      action,
      auth: { user: currentUser },
      details: {
        requiredPermission: permission,
        resourceScope: auditTarget,
        roles: currentUser.roles,
      },
      outcome: allowed ? "allowed" : "denied",
      permission,
      reason: allowed ? undefined : "access_policy_denied",
      target: auditTarget,
    });

    if (!allowed) {
      return c.json({ error: "Forbidden", permission }, 403);
    }

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
    email: "settings-assignment-scope@example.com",
    groups: [],
    id: "user_settings_assignment_scope",
    name: "Settings Assignment Scope User",
    permissions: ["settings:read", "settings:manage"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
