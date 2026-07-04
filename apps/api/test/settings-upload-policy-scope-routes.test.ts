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

const scopeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-policy-scope-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  scopeRoot,
  "channel-map-assignments.json",
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
const { createSettingsStore } = await import("../src/settings-store.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createUploadPolicy, findUploadPolicy } = await import("../src/upload-policies.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");

test.after(async () => {
  await rm(scopeRoot, { force: true, recursive: true });
});

test("upload policy routes honor resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const hiddenPolicy = await createUploadPolicy({
    enabled: true,
    maxAttempts: 3,
    name: `Hidden Upload Policy ${randomUUID()}`,
    provider: "stub",
    target: "stub://hidden-policy",
    trigger: "manual",
  });
  const hiddenPolicyId = hiddenPolicy.id;
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "upload_policy" && target.id === hiddenPolicyId);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore: createSettingsStore(),
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const listResponse = await app.request("/api/v1/settings/upload-policies");
  const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
  const detailResponse = await app.request(`/api/v1/settings/upload-policies/${hiddenPolicyId}`);
  const actionsResponse = await app.request(
    `/api/v1/settings/upload-policies/${hiddenPolicyId}/actions`,
  );
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/upload-policies/${hiddenPolicyId}`,
    "PATCH",
    { maxAttempts: 9, name: "Hidden Upload Policy Update" },
  );
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:read" });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedPolicy = await findUploadPolicy(hiddenPolicyId);

  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.data.some((policy) => policy.id === hiddenPolicyId),
    false,
  );
  assert.equal(detailResponse.status, 403);
  assert.equal(actionsResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(storedPolicy?.name, hiddenPolicy.name);
  assert.equal(storedPolicy?.maxAttempts, hiddenPolicy.maxAttempts);
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.upload_policies.actions.read",
    "settings.upload_policies.detail.read",
  ]);
  assert.equal(manageDeniedEvents[0]?.action, "settings.upload_policies.update");
  assert.ok(
    [...deniedEvents, ...manageDeniedEvents].every(
      (event) =>
        event.reason === "access_policy_denied" &&
        event.target.id === hiddenPolicyId &&
        event.target.type === "upload_policy",
    ),
  );
});

test("upload policy create rejects an out-of-scope or unknown destination reference", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const uploadDestinationStore = createUploadDestinationStore();
  const hidden = await uploadDestinationStore.create({
    displayName: "Hidden Destination",
    enabled: true,
    kind: "smb",
    smb: { server: "hidden.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const visible = await uploadDestinationStore.create({
    displayName: "Visible Destination",
    enabled: true,
    kind: "smb",
    smb: { server: "visible.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "upload_destination" && target.id === hidden.id);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore: createSettingsStore(),
    uploadDestinationStore,
  });

  const basePolicy = { enabled: true, maxAttempts: 3, trigger: "manual" };
  const denied = await requestJson(app, "/api/v1/settings/upload-policies", "POST", {
    ...basePolicy,
    destinationId: hidden.id,
    name: "Bind Hidden Destination",
  });
  const unknown = await requestJson(app, "/api/v1/settings/upload-policies", "POST", {
    ...basePolicy,
    destinationId: "dest_does_not_exist",
    name: "Bind Unknown Destination",
  });
  const allowed = await requestJson(app, "/api/v1/settings/upload-policies", "POST", {
    ...basePolicy,
    destinationId: visible.id,
    name: "Bind Visible Destination",
  });

  // A scoped-out destination is 403 (the caller can't reference what they can't
  // see); a non-existent one is 400; an in-scope one succeeds.
  assert.equal(denied.status, 403);
  assert.equal(unknown.status, 400);
  assert.equal(allowed.status, 201);

  const denials = await auditStore.list({ outcome: "denied", permission: "settings:manage" });

  assert.ok(
    denials.some(
      (event) =>
        event.action === "settings.upload_policies.create.failed" &&
        event.target.type === "upload_destination" &&
        event.target.id === hidden.id,
    ),
  );
});

test("R28: upload policy create with a duplicate id is a 409 and does not overwrite", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async () => true,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, () => true),
    settingsStore: createSettingsStore(),
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const policyId = `upload_policy_dup_${randomUUID()}`;
  const first = await requestJson(app, "/api/v1/settings/upload-policies", "POST", {
    enabled: true,
    id: policyId,
    maxAttempts: 3,
    name: "Original Policy",
    trigger: "manual",
  });
  const conflict = await requestJson(app, "/api/v1/settings/upload-policies", "POST", {
    enabled: true,
    id: policyId,
    maxAttempts: 9,
    name: "Impostor Policy",
    trigger: "manual",
  });
  const conflictBody = (await conflict.json()) as { reason?: string };
  const stored = await findUploadPolicy(policyId);
  const failed = await auditStore.list({ action: "settings.upload_policies.create.failed" });

  assert.equal(first.status, 201);
  assert.equal(conflict.status, 409);
  assert.equal(conflictBody.reason, "upload_policy_exists");
  // The create must not have upserted over the original row.
  assert.equal(stored?.name, "Original Policy");
  assert.equal(stored?.maxAttempts, 3);
  assert.equal(failed.at(-1)?.reason, "upload_policy_exists");
});

function requestJson(
  app: Hono<AppBindings>,
  url: string,
  method: "PATCH" | "POST",
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
    email: "settings-policy-scope@example.com",
    groups: [],
    id: "user_settings_policy_scope",
    name: "Settings Policy Scope User",
    permissions: ["settings:read", "settings:manage"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
