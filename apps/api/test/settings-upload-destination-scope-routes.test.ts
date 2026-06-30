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
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(scopeRoot, "upload-providers.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(scopeRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");

test.after(async () => {
  await rm(scopeRoot, { force: true, recursive: true });
});

test("upload destination routes honor resource-scope denies", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer();
  const settingsStore = createSettingsStore();
  const uploadDestinationStore = createUploadDestinationStore();
  const hidden = await uploadDestinationStore.create({
    displayName: "Hidden Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const hiddenDestinationId = hidden.id;
  const isVisibleTarget = (target: AuditTarget) =>
    !(target.type === "upload_destination" && target.id === hiddenDestinationId);

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    hasResourceScope: async (_user, target) => isVisibleTarget(target),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyResourceScope(auditStore, currentUser, isVisibleTarget),
    settingsStore,
    uploadDestinationStore,
  });

  const listResponse = await app.request("/api/v1/settings/upload-destinations");
  const listBody = (await listResponse.json()) as { data: Array<{ id: string }> };
  const detailResponse = await app.request(
    `/api/v1/settings/upload-destinations/${hiddenDestinationId}`,
  );
  const actionsResponse = await app.request(
    `/api/v1/settings/upload-destinations/${hiddenDestinationId}/actions`,
  );
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/upload-destinations/${hiddenDestinationId}`,
    "PATCH",
    { displayName: "Hidden Destination Update" },
  );
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:read" });
  const manageDeniedEvents = await auditStore.list({
    outcome: "denied",
    permission: "settings:manage",
  });
  const storedDestination = await uploadDestinationStore.find(hiddenDestinationId);

  assert.equal(listResponse.status, 200);
  assert.equal(
    listBody.data.some((destination) => destination.id === hiddenDestinationId),
    false,
  );
  assert.equal(detailResponse.status, 403);
  assert.equal(actionsResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(storedDestination?.displayName, "Hidden Share");
  assert.deepEqual(deniedEvents.map((event) => event.action).sort(), [
    "settings.upload_destinations.actions.read",
    "settings.upload_destinations.detail.read",
  ]);
  assert.equal(manageDeniedEvents[0]?.action, "settings.upload_destinations.update");
  assert.ok(
    [...deniedEvents, ...manageDeniedEvents].every(
      (event) =>
        event.reason === "access_policy_denied" &&
        event.target.id === hiddenDestinationId &&
        event.target.type === "upload_destination",
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
