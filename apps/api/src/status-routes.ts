import type { Context, Hono } from "hono";
import {
  defaultScheduledVoiceWatchdogPolicy,
  defaultVoiceRecordingProfile,
  type RecorderNode,
  type RecordingSummary,
} from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { HealthEventStore } from "./health-store.js";
import type { AppBindings, AuditTarget, RequirePermission } from "./http-types.js";
import { scopedHealthEvents } from "./metrics-routes.js";

interface StatusRouteDependencies {
  app: Hono<AppBindings>;
  currentUser: (c: Context<AppBindings>) => NonNullable<AuthResult["user"]>;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
  healthEventStore: HealthEventStore;
  requirePermission: RequirePermission;
  scopedNodes: (user: NonNullable<AuthResult["user"]>) => Promise<RecorderNode[]>;
  scopedRecordings: (user: NonNullable<AuthResult["user"]>) => Promise<RecordingSummary[]>;
  startedAt: Date;
}

export function registerStatusRoutes(dependencies: StatusRouteDependencies) {
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

      return c.json({
        activeRecordings: visibleRecordings.filter((recording) => recording.status === "recording")
          .length,
        cachedRecordings: visibleRecordings.filter((recording) => recording.cached).length,
        criticalAlerts: visibleHealthEvents.filter(
          (event) => event.severity === "critical" && event.status !== "resolved",
        ).length,
        nodeCount: visibleNodes.length,
        onlineNodes: visibleNodes.filter((node) => node.status === "online").length,
        recordingProfile: defaultVoiceRecordingProfile,
        startedAt: dependencies.startedAt.toISOString(),
        watchdogPolicy: defaultScheduledVoiceWatchdogPolicy,
      });
    },
  );
}
