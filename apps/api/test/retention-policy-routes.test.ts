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

const retentionRoot = await mkdtemp(path.join(tmpdir(), "rakkr-retention-policies-"));
process.env.RAKKR_RETENTION_POLICY_STORE_PATH = path.join(retentionRoot, "policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { registerRetentionPolicyRoutes } = await import("../src/retention-policy-routes.js");
const { createRetentionPolicy, findRetentionPolicy } = await import("../src/retention-policies.js");

test.after(async () => {
  await rm(retentionRoot, { force: true, recursive: true });
});

test("retention policy routes deny users without settings permissions", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer([]);

  registerRetentionPolicyRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, currentUser),
  });

  const responses = await Promise.all([
    app.request("/api/v1/settings/retention-policies"),
    app.request("/api/v1/settings/retention-policies/retention-keep-controller-cache"),
    app.request("/api/v1/settings/retention-policies/retention-keep-controller-cache/actions"),
    requestJson(app, "/api/v1/settings/retention-policies", "POST", {
      action: "delete_cache",
      maxAgeDays: 30,
      name: "Blocked Retention",
      scope: "recorder_cache",
    }),
    requestJson(
      app,
      "/api/v1/settings/retention-policies/retention-keep-controller-cache",
      "PATCH",
      { name: "Blocked Retention Update" },
    ),
  ]);
  const deniedEvents = await auditStore.list({ outcome: "denied" });

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403],
  );
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.retention_policies.actions.read",
    "settings.retention_policies.create",
    "settings.retention_policies.detail.read",
    "settings.retention_policies.read",
    "settings.retention_policies.update",
  ]);
  assert.deepEqual(deniedEvents.map((event) => event.permission).sort(), [
    "settings:manage",
    "settings:manage",
    "settings:read",
    "settings:read",
    "settings:read",
  ]);
});

test("retention policy routes create update and audit snapshots", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:manage", "settings:read"]);

  registerRetentionPolicyRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
  });

  const createResponse = await requestJson(app, "/api/v1/settings/retention-policies", "POST", {
    action: "delete_cache",
    deleteOnlyAfterUploaded: true,
    maxAgeDays: 14,
    minFreeDiskPercent: 15,
    name: "Recorder Cache Cleanup",
    preserveTagged: true,
    scope: "recorder_cache",
  });
  const created = (await createResponse.json()) as { data: { id: string } };
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/retention-policies/${created.data.id}`,
    "PATCH",
    {
      enabled: false,
      maxAgeDays: 21,
      name: "Recorder Cache Cleanup Paused",
    },
  );
  const detailResponse = await app.request(
    `/api/v1/settings/retention-policies/${created.data.id}`,
  );
  const actionsResponse = await app.request(
    `/api/v1/settings/retention-policies/${created.data.id}/actions`,
  );
  const listResponse = await app.request("/api/v1/settings/retention-policies");
  const updated = (await updateResponse.json()) as {
    data: { enabled: boolean; maxAgeDays: number; name: string };
  };
  const detail = (await detailResponse.json()) as { data: { id: string; name: string } };
  const actionSummary = (await actionsResponse.json()) as {
    data: { actions: { update: { enabled: boolean; href?: string } } };
  };
  const listed = (await listResponse.json()) as { data: { id: string }[] };
  const audits = await auditStore.list({ permission: "settings:manage" });

  assert.equal(createResponse.status, 201);
  assert.equal(updateResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.equal(actionsResponse.status, 200);
  assert.equal(listResponse.status, 200);
  assert.equal(detail.data.id, created.data.id);
  assert.equal(detail.data.name, "Recorder Cache Cleanup Paused");
  assert.equal(actionSummary.data.actions.update.enabled, true);
  assert.equal(
    actionSummary.data.actions.update.href,
    `/api/v1/settings/retention-policies/${created.data.id}`,
  );
  assert.equal(updated.data.enabled, false);
  assert.equal(updated.data.maxAgeDays, 21);
  assert.equal(updated.data.name, "Recorder Cache Cleanup Paused");
  assert.ok(listed.data.some((policy) => policy.id === created.data.id));
  assert.deepEqual(audits.map((event) => event.action).sort(), [
    "settings.retention_policies.create.succeeded",
    "settings.retention_policies.update.succeeded",
  ]);

  const updateAudit = audits.find(
    (event) => event.action === "settings.retention_policies.update.succeeded",
  );

  assert.equal(updateAudit?.before?.maxAgeDays, 14);
  assert.equal(updateAudit?.after?.maxAgeDays, 21);
  assert.equal(updateAudit?.target.type, "retention_policy");
});

test("retention policy read routes audit list detail and missing resources", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read"]);
  const policy = await createRetentionPolicy({
    action: "delete_cache",
    deleteOnlyAfterUploaded: true,
    maxAgeDays: 45,
    name: `Read Audit Retention ${randomUUID()}`,
    scope: "controller_cache",
  });

  registerRetentionPolicyRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
  });

  const listResponse = await app.request("/api/v1/settings/retention-policies");
  const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
  const detailResponse = await app.request(`/api/v1/settings/retention-policies/${policy.id}`);
  const missingResponse = await app.request(
    "/api/v1/settings/retention-policies/retention_missing_read",
  );
  const successAudits = await auditStore.list({
    outcome: "succeeded",
    permission: "settings:read",
  });
  const failedAudits = await auditStore.list({
    outcome: "failed",
    permission: "settings:read",
  });

  assert.equal(listResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.equal(missingResponse.status, 404);
  assert.ok(listBody.data.some((candidate) => candidate.id === policy.id));
  assert.deepEqual(successAudits.map((event) => event.action).sort(), [
    "settings.retention_policies.detail.read.succeeded",
    "settings.retention_policies.read.succeeded",
  ]);
  assert.equal(
    successAudits.find((event) => event.action === "settings.retention_policies.read.succeeded")
      ?.details.returnedCount,
    listBody.data.length,
  );
  assert.equal(
    successAudits.find(
      (event) => event.action === "settings.retention_policies.detail.read.succeeded",
    )?.target.id,
    policy.id,
  );
  assert.equal(failedAudits.length, 1);
  assert.equal(failedAudits[0]?.action, "settings.retention_policies.detail.read.failed");
  assert.equal(failedAudits[0]?.reason, "not_found");
  assert.equal(failedAudits[0]?.target.id, "retention_missing_read");
});

test("retention policy routes honor resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:read", "settings:manage"]);
  const hiddenPolicy = await createRetentionPolicy({
    action: "delete_cache",
    deleteOnlyAfterUploaded: true,
    maxAgeDays: 30,
    name: `Hidden Retention Policy ${randomUUID()}`,
    scope: "controller_cache",
  });
  const hiddenPolicyId = hiddenPolicy.id;
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "retention_policy" && target.id === hiddenPolicyId);

  registerRetentionPolicyRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
  });

  const listResponse = await app.request("/api/v1/settings/retention-policies");
  const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
  const detailResponse = await app.request(`/api/v1/settings/retention-policies/${hiddenPolicyId}`);
  const actionsResponse = await app.request(
    `/api/v1/settings/retention-policies/${hiddenPolicyId}/actions`,
  );
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/retention-policies/${hiddenPolicyId}`,
    "PATCH",
    { maxAgeDays: 90, name: "Hidden Retention Policy Update" },
  );
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:read" });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedPolicy = await findRetentionPolicy(hiddenPolicyId);

  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.data.some((policy) => policy.id === hiddenPolicyId),
    false,
  );
  assert.equal(detailResponse.status, 403);
  assert.equal(actionsResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(storedPolicy?.name, hiddenPolicy.name);
  assert.equal(storedPolicy?.maxAgeDays, hiddenPolicy.maxAgeDays);
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.retention_policies.actions.read",
    "settings.retention_policies.detail.read",
  ]);
  assert.equal(manageDeniedEvents[0]?.action, "settings.retention_policies.update");
  assert.ok(
    [...deniedEvents, ...manageDeniedEvents].every(
      (event) =>
        event.reason === "access_policy_denied" &&
        event.target.id === hiddenPolicyId &&
        event.target.type === "retention_policy",
    ),
  );
});

function requestJson(
  app: Hono<AppBindings>,
  targetPath: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
) {
  return app.request(targetPath, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
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

function viewer(permissions = ["settings:read"]): CurrentUser {
  return {
    email: "retention-viewer@example.com",
    groups: [],
    id: "user_retention_viewer_test",
    name: "Retention Viewer Test",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["viewer"],
  };
}
