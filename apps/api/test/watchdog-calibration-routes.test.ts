import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { AuditEvent, CurrentUser, MeterFrame, Permission } from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent, RequirePermission } from "../src/http-types.js";

const calibrationRoot = await mkdtemp(path.join(tmpdir(), "rakkr-watchdog-calibration-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_CHANNEL_MAP_ASSIGNMENT_STORE_PATH = path.join(
  calibrationRoot,
  "channel-map-assignments.json",
);
process.env.RAKKR_CHANNEL_MAP_TEMPLATE_STORE_PATH = path.join(
  calibrationRoot,
  "channel-map-templates.json",
);
process.env.RAKKR_RECORDING_PROFILE_STORE_PATH = path.join(calibrationRoot, "profiles.json");
process.env.RAKKR_WATCHDOG_POLICY_STORE_PATH = path.join(calibrationRoot, "watchdog-policies.json");

const { createAuditStore } = await import("../src/audit-store.js");
const { createMeterFrameStore } = await import("../src/meter-store.js");
const { createSettingsStore } = await import("../src/settings-store.js");
const { registerWatchdogCalibrationRoutes } = await import("../src/watchdog-calibration-routes.js");

test.after(async () => {
  await rm(calibrationRoot, { force: true, recursive: true });
});

test("watchdog calibration route denies users without settings manage", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer([]);

  registerWatchdogCalibrationRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    meterFrameStore: createMeterFrameStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: denyMissingPermission(auditStore, currentUser),
    settingsStore: createSettingsStore(),
  });

  const response = await requestCalibration(app, "scheduled-voice-watchdog", {
    nodeId: "node_field",
  });
  const deniedEvents = await auditStore.list({ outcome: "denied", permission: "settings:manage" });

  assert.equal(response.status, 403);
  assert.equal(deniedEvents[0]?.action, "settings.watchdog_policies.calibrate");
  assert.equal(deniedEvents[0]?.target.id, "scheduled-voice-watchdog");
});

test("watchdog calibration applies recommended field threshold from recent meter history", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const meterFrameStore = createMeterFrameStore();
  const settingsStore = createSettingsStore();
  const currentUser = viewer(["settings:manage"]);

  for (const [index, rmsDbfs] of [-30, -28, -24, -20, -18].entries()) {
    await meterFrameStore.save(meterFrame("node_field", rmsDbfs, index));
  }

  registerWatchdogCalibrationRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    meterFrameStore,
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore,
  });

  const response = await requestCalibration(app, "scheduled-voice-watchdog", {
    apply: true,
    frameLimit: 5,
    minFrames: 5,
    nodeId: "node_field",
    signalMarginDb: 6,
  });
  const body = (await response.json()) as {
    data: {
      calibration: {
        analysis: { frameCount: number; observedP95MetricDbfs: number };
        applied: boolean;
        recommendation: { update: { thresholdDbfs: number } };
      };
      policy: { thresholdDbfs: number };
    };
  };
  const updated = await settingsStore.findWatchdogPolicy("scheduled-voice-watchdog");
  const [event] = await auditStore.list({
    action: "settings.watchdog_policies.calibrate.succeeded",
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.calibration.analysis.frameCount, 5);
  assert.equal(body.data.calibration.analysis.observedP95MetricDbfs, -18);
  assert.equal(body.data.calibration.recommendation.update.thresholdDbfs, -24);
  assert.equal(body.data.calibration.applied, true);
  assert.equal(body.data.policy.thresholdDbfs, -24);
  assert.equal(updated?.thresholdDbfs, -24);
  assert.equal(event?.after?.thresholdDbfs, -24);
  assert.equal(event?.details.applied, true);
});

test("watchdog calibration audits insufficient meter history", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const currentUser = viewer(["settings:manage"]);

  registerWatchdogCalibrationRoutes({
    app,
    currentAuth: () => ({ user: currentUser }),
    meterFrameStore: createMeterFrameStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    requirePermission: allowPermission(),
    settingsStore: createSettingsStore(),
  });

  const response = await requestCalibration(app, "scheduled-voice-watchdog", {
    minFrames: 5,
    nodeId: "node_empty",
  });
  const [event] = await auditStore.list({
    action: "settings.watchdog_policies.calibrate.failed",
  });

  assert.equal(response.status, 422);
  assert.equal(event?.reason, "insufficient_meter_history");
  assert.equal(event?.target.id, "scheduled-voice-watchdog");
});

function requestCalibration(
  app: Hono<AppBindings>,
  policyId: string,
  body: Record<string, unknown>,
) {
  return app.request(`/api/v1/settings/watchdog-policies/${policyId}/calibrations`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
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

function viewer(permissions: Permission[]): CurrentUser {
  return {
    email: "watchdog-calibration@example.com",
    groups: [],
    id: "user_watchdog_calibration",
    name: "Watchdog Calibration User",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}

function meterFrame(nodeId: string, rmsDbfs: number, index: number): MeterFrame {
  return {
    capturedAt: new Date(Date.UTC(2026, 5, 20, 10, 0, index)).toISOString(),
    interfaceId: "iface_field",
    levels: [
      {
        channelIndex: 1,
        clipping: false,
        label: "Podium",
        peakDbfs: rmsDbfs + 8,
        quality: {
          crestFactorDb: 12,
          noiseScore: 0.2,
          speechLike: true,
          speechScore: 0.82,
          zeroCrossingRate: 0.18,
        },
        rmsDbfs,
      },
    ],
    nodeId,
  };
}
