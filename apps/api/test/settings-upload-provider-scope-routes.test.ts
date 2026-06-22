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

const scopeRoot = await mkdtemp(path.join(tmpdir(), "rakkr-settings-provider-scope-"));
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
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(scopeRoot, "upload-providers.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(scopeRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createUploadProviderStore } = await import("../src/upload-providers.js");

test.after(async () => {
  await rm(scopeRoot, { force: true, recursive: true });
});

test("upload provider routes honor resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const settingsStore = createSettingsStore();
  const uploadProviderStore = createUploadProviderStore();
  const hiddenProviderId = "stub";
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "upload_provider" && target.id === hiddenProviderId);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore,
    uploadProviderStore,
  });

  const listResponse = await app.request("/api/v1/settings/upload-providers");
  const listBody = (await listResponse.json()) as { data: Array<{ provider: string }> };
  const detailResponse = await app.request(`/api/v1/settings/upload-providers/${hiddenProviderId}`);
  const actionsResponse = await app.request(
    `/api/v1/settings/upload-providers/${hiddenProviderId}/actions`,
  );
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/upload-providers/${hiddenProviderId}`,
    "PATCH",
    { displayName: "Hidden Provider Update", target: "stub://hidden" },
  );
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:read" });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedProvider = await uploadProviderStore.findStatus(hiddenProviderId);

  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.data.some((provider) => provider.provider === hiddenProviderId),
    false,
  );
  assert.equal(detailResponse.status, 403);
  assert.equal(actionsResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(storedProvider.displayName, "Stub Queue Provider");
  assert.equal(storedProvider.target, "stub://queue-only");
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.upload_providers.actions.read",
    "settings.upload_providers.detail.read",
  ]);
  assert.equal(manageDeniedEvents[0]?.action, "settings.upload_providers.update");
  assert.ok(
    [...deniedEvents, ...manageDeniedEvents].every(
      (event) =>
        event.reason === "access_policy_denied" &&
        event.target.id === hiddenProviderId &&
        event.target.type === "upload_provider",
    ),
  );
});

function requestJson(
  app: Hono<AppBindings>,
  url: string,
  method: "PATCH",
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
    email: "settings-provider-scope@example.com",
    groups: [],
    id: "user_settings_provider_scope",
    name: "Settings Provider Scope User",
    permissions: ["settings:read", "settings:manage"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
