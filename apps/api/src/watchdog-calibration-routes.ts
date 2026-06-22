import type { Context, Hono } from "hono";
import type { WatchdogPolicy } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import type { MeterFrameStore } from "./meter-store.js";
import type { SettingsStore } from "./settings-store.js";
import {
  calibrateWatchdogPolicy,
  WatchdogCalibrationError,
  watchdogCalibrationInputSchema,
} from "./watchdog-calibration.js";

interface WatchdogCalibrationRouteDependencies {
  app: Hono<AppBindings>;
  currentAuth: (c: Context<AppBindings>) => AuthResult;
  hasResourceScope?(user: NonNullable<AuthResult["user"]>, target: AuditTarget): Promise<boolean>;
  meterFrameStore: MeterFrameStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
}

export function registerWatchdogCalibrationRoutes({
  app,
  currentAuth,
  hasResourceScope = async () => true,
  meterFrameStore,
  recordAuditEvent,
  requirePermission,
  settingsStore,
}: WatchdogCalibrationRouteDependencies) {
  app.post(
    "/api/v1/settings/watchdog-policies/:policyId/calibrations",
    requirePermission("settings:manage", "settings.watchdog_policies.calibrate", (c) => ({
      id: c.req.param("policyId"),
      type: "watchdog_policy",
    })),
    async (c) => {
      const policyId = c.req.param("policyId");
      const policy = await settingsStore.findWatchdogPolicy(policyId);

      if (!policy) {
        await recordCalibrationFailure(c, "policy_not_found", {
          id: policyId,
          type: "watchdog_policy",
        });
        return c.json({ error: "Watchdog policy not found" }, 404);
      }

      const body = watchdogCalibrationInputSchema.safeParse(await c.req.json().catch(() => ({})));

      if (!body.success) {
        await recordCalibrationFailure(c, "invalid_request", watchdogAuditTarget(policy));
        return c.json({ error: "Invalid watchdog calibration", issues: body.error.issues }, 400);
      }

      const nodeTarget = { id: body.data.nodeId, type: "node" as const };
      const auth = currentAuth(c);

      if (!auth.user || !(await hasResourceScope(auth.user, nodeTarget))) {
        await recordCalibrationFailure(c, "missing_resource_scope", nodeTarget);
        return c.json({ error: "Forbidden", permission: "settings:manage" }, 403);
      }

      const frames = await meterFrameStore.history(body.data.nodeId, body.data.frameLimit);

      try {
        const calibration = calibrateWatchdogPolicy(policy, frames, body.data);
        const updated = body.data.apply
          ? await settingsStore.updateWatchdogPolicy(policy.id, calibration.recommendation.update)
          : undefined;

        await recordAuditEvent(c, {
          action: "settings.watchdog_policies.calibrate.succeeded",
          after: updated ? watchdogSnapshot(updated) : calibration.recommendation.update,
          auth: currentAuth(c),
          before: watchdogSnapshot(policy),
          details: {
            analysis: calibration.analysis,
            applied: body.data.apply,
            frameLimit: body.data.frameLimit,
            nodeId: body.data.nodeId,
            recommendation: calibration.recommendation,
            warnings: calibration.warnings,
          },
          outcome: "succeeded",
          permission: "settings:manage",
          target: watchdogAuditTarget(updated ?? policy),
        });

        return c.json({ data: { calibration, policy: updated } });
      } catch (error) {
        if (error instanceof WatchdogCalibrationError) {
          await recordCalibrationFailure(c, error.code, watchdogAuditTarget(policy));
          return c.json({ error: "Not enough meter history for calibration" }, 422);
        }

        throw error;
      }
    },
  );

  async function recordCalibrationFailure(
    c: Context<AppBindings>,
    reason: string,
    target: { id?: string; name?: string; type: string } = { type: "watchdog_policy" },
  ) {
    await recordAuditEvent(c, {
      action: "settings.watchdog_policies.calibrate.failed",
      auth: currentAuth(c),
      outcome: reason === "missing_resource_scope" ? "denied" : "failed",
      permission: "settings:manage",
      reason,
      target,
    });
  }
}

function watchdogAuditTarget(policy: WatchdogPolicy | { id?: string }) {
  return {
    id: policy.id,
    name: "name" in policy ? policy.name : undefined,
    type: "watchdog_policy",
  };
}

function watchdogSnapshot(policy: WatchdogPolicy) {
  return {
    activeDuring: policy.activeDuring,
    broadbandNoiseScoreThreshold: policy.broadbandNoiseScoreThreshold,
    channelCorrelationMode: policy.channelCorrelationMode ?? "off",
    channelCorrelationThreshold: policy.channelCorrelationThreshold,
    clippingMode: policy.clippingMode ?? "off",
    flatlineMode: policy.flatlineMode ?? "off",
    flatlineThresholdDbfs: policy.flatlineThresholdDbfs,
    graceSeconds: policy.graceSeconds,
    humScoreThreshold: policy.humScoreThreshold,
    id: policy.id,
    metric: policy.metric,
    minCumulativeChannelCorrelationSeconds: policy.minCumulativeChannelCorrelationSeconds,
    minCumulativeClippingSeconds: policy.minCumulativeClippingSeconds,
    minCumulativeFlatlineSeconds: policy.minCumulativeFlatlineSeconds,
    minCumulativeQualitySeconds: policy.minCumulativeQualitySeconds,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    minCumulativeSpeechSeconds: policy.minCumulativeSpeechSeconds,
    minSpeechScore: policy.minSpeechScore,
    name: policy.name,
    noiseScoreThreshold: policy.noiseScoreThreshold,
    qualityAlertMode: policy.qualityAlertMode ?? "off",
    qualityMode: policy.qualityMode ?? "signal_only",
    repeatEverySeconds: policy.repeatEverySeconds,
    severity: policy.severity,
    staticScoreThreshold: policy.staticScoreThreshold,
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
  };
}
