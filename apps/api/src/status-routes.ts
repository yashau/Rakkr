import type { Context, Hono } from "hono";
import {
  defaultScheduledVoiceWatchdogPolicy,
  defaultVoiceRecordingProfile,
  type HealthEvent,
  type RecorderNode,
  type RecordingSummary,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import type {
  AppBindings,
  AuditTarget,
  RecordAuditEvent,
  RequirePermission,
} from "./http-types.js";
import { scopedHealthEvents } from "./metrics-routes.js";
import {
  profileSettingsTarget,
  scopedRecordingProfiles,
  scopedWatchdogPolicies,
  watchdogSettingsTarget,
} from "./settings-scope.js";
import type { SettingsStore } from "./settings-store.js";

interface StatusRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  healthEventStore: HealthEventStore;
  recordAuditEvent: RecordAuditEvent;
  requirePermission: RequirePermission;
  settingsStore: SettingsStore;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
  startedAt: Date;
}

export function registerStatusRoutes(dependencies: StatusRouteDependencies) {
  dependencies.app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "rakkr-api",
      startedAt: dependencies.startedAt.toISOString(),
    }),
  );

  dependencies.app.get(
    "/api/v1/status",
    dependencies.requirePermission("node:read", "status.read"),
    async (c) => {
      const user = dependencies.currentUser(c);
      const visibleNodes = await dependencies.scopedNodes(user);
      const visibleRecordings = await dependencies.scopedRecordings(user);
      const visibleHealthEvents = await scopedHealthEvents(user, {
        hasResourceScope: dependencies.hasResourceScope,
        healthEventStore: dependencies.healthEventStore,
      });
      const canReadSettings = user.permissions.includes("settings:read");
      const recordingProfile = canReadSettings
        ? await defaultRecordingProfile(user, dependencies)
        : undefined;
      const watchdogPolicy = canReadSettings
        ? await defaultWatchdogPolicy(user, dependencies)
        : undefined;
      const payload = {
        activeRecordings: visibleRecordings.filter((recording) => recording.status === "recording")
          .length,
        alertingNodes: nodeStatusCount(visibleNodes, "alerting"),
        acknowledgedAlerts: healthStatusCount(visibleHealthEvents, "acknowledged"),
        cachedRecordings: visibleRecordings.filter((recording) => recording.cached).length,
        completedRecordings: recordingStatusCount(visibleRecordings, "completed"),
        criticalAlerts: visibleHealthEvents.filter(
          (event) => event.severity === "critical" && event.status !== "resolved",
        ).length,
        degradedNodes: nodeStatusCount(visibleNodes, "degraded"),
        failedRecordings: recordingStatusCount(visibleRecordings, "failed"),
        nodeCount: visibleNodes.length,
        offlineNodes: nodeStatusCount(visibleNodes, "offline"),
        onlineNodes: nodeStatusCount(visibleNodes, "online"),
        openAlerts: healthStatusCount(visibleHealthEvents, "open"),
        queuedRecordings: recordingStatusCount(visibleRecordings, "queued"),
        recordingNodes: nodeStatusCount(visibleNodes, "recording"),
        ...(recordingProfile ? { recordingProfile } : {}),
        startedAt: dependencies.startedAt.toISOString(),
        suppressedAlerts: healthStatusCount(visibleHealthEvents, "suppressed"),
        totalRecordings: visibleRecordings.length,
        unresolvedAlerts: visibleHealthEvents.filter((event) => event.status !== "resolved").length,
        uploadedRecordings: recordingStatusCount(visibleRecordings, "uploaded"),
        warningAlerts: visibleHealthEvents.filter(
          (event) => event.severity === "warning" && event.status !== "resolved",
        ).length,
        ...(watchdogPolicy ? { watchdogPolicy } : {}),
      };

      await dependencies.recordAuditEvent(c, {
        action: "status.read.succeeded",
        auth: { user },
        details: {
          activeRecordings: payload.activeRecordings,
          canReadSettings,
          criticalAlerts: payload.criticalAlerts,
          nodeCount: payload.nodeCount,
          openAlerts: payload.openAlerts,
          recordingProfileAvailable: Boolean(recordingProfile),
          totalRecordings: payload.totalRecordings,
          unresolvedAlerts: payload.unresolvedAlerts,
          watchdogPolicyAvailable: Boolean(watchdogPolicy),
        },
        outcome: "succeeded",
        permission: "node:read",
        target: { type: "controller" },
      });

      return c.json(payload);
    },
  );
}

function healthStatusCount(events: HealthEvent[], status: HealthEvent["status"]) {
  return events.filter((event) => event.status === status).length;
}

function nodeStatusCount(nodes: RecorderNode[], status: RecorderNode["status"]) {
  return nodes.filter((node) => node.status === status).length;
}

function recordingStatusCount(recordings: RecordingSummary[], status: RecordingSummary["status"]) {
  return recordings.filter((recording) => recording.status === status).length;
}

async function defaultRecordingProfile(
  user: NonNullable<AuthResult["user"]>,
  dependencies: Pick<StatusRouteDependencies, "hasResourceScope" | "settingsStore">,
) {
  const profiles = await scopedRecordingProfiles(
    user,
    dependencies.settingsStore,
    dependencies.hasResourceScope,
  );

  return (
    profiles.find((profile) => profile.id === defaultVoiceRecordingProfile.id) ??
    profiles[0] ??
    ((await dependencies.hasResourceScope(
      user,
      profileSettingsTarget(defaultVoiceRecordingProfile),
    ))
      ? defaultVoiceRecordingProfile
      : undefined)
  );
}

async function defaultWatchdogPolicy(
  user: NonNullable<AuthResult["user"]>,
  dependencies: Pick<StatusRouteDependencies, "hasResourceScope" | "settingsStore">,
) {
  const watchdogPolicies = await scopedWatchdogPolicies(
    user,
    dependencies.settingsStore,
    dependencies.hasResourceScope,
  );

  return (
    watchdogPolicies.find((policy) => policy.id === defaultScheduledVoiceWatchdogPolicy.id) ??
    watchdogPolicies[0] ??
    ((await dependencies.hasResourceScope(
      user,
      watchdogSettingsTarget(defaultScheduledVoiceWatchdogPolicy),
    ))
      ? defaultScheduledVoiceWatchdogPolicy
      : undefined)
  );
}
