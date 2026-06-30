import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const root = await mkdtemp(path.join(tmpdir(), "rakkr-upload-destination-routes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(root, "destinations.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { registerSettingsRoutes } = await import("../src/settings-routes.js");
const { createUploadDestinationStore } = await import("../src/upload-destinations.js");

test.after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("upload destination routes create, update, and delete destinations with audit", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");

  registerSettingsRoutes({
    app,
    currentAuth: () => ({ user: manager() }),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore: createSettingsStore(),
    uploadDestinationStore: createUploadDestinationStore(),
  });

  const createResponse = await requestJson(app, "/api/v1/settings/upload-destinations", "POST", {
    displayName: "Council Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
    smbPassword: "s3cr3t",
  });
  const created = (
    (await createResponse.json()) as { data: { hasSmbPassword: boolean; id: string } }
  ).data;
  const updateResponse = await requestJson(
    app,
    `/api/v1/settings/upload-destinations/${created.id}`,
    "PATCH",
    { displayName: "Council Share Rev 2" },
  );
  const updated = ((await updateResponse.json()) as { data: { displayName: string } }).data;
  const deleteResponse = await app.request(`/api/v1/settings/upload-destinations/${created.id}`, {
    method: "DELETE",
  });
  const detailAfterDelete = await app.request(`/api/v1/settings/upload-destinations/${created.id}`);
  const actions = (await auditStore.list({ outcome: "succeeded", permission: "settings:manage" }))
    .map((event) => event.action)
    .sort();

  assert.equal(createResponse.status, 201);
  assert.equal(created.hasSmbPassword, true);
  assert.equal(updateResponse.status, 200);
  assert.equal(updated.displayName, "Council Share Rev 2");
  assert.equal(deleteResponse.status, 200);
  assert.equal(detailAfterDelete.status, 404);
  assert.deepEqual(actions, [
    "settings.upload_destinations.create.succeeded",
    "settings.upload_destinations.delete.succeeded",
    "settings.upload_destinations.update.succeeded",
  ]);
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

function allowPermission(): RequirePermission {
  return () => async (_c, next) => {
    await next();
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? {
        id: input.auth?.user?.id ?? "anonymous",
        name: input.auth?.user?.name ?? "Anonymous",
        roles: input.auth?.user?.roles ?? [],
        type: "user" as const,
      },
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

function manager(): CurrentUser {
  return {
    email: "upload-destination-routes@example.com",
    groups: [],
    id: "user_upload_destination_routes",
    name: "Upload Destination Routes User",
    permissions: ["settings:manage", "settings:read"],
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
