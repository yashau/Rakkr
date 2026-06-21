import type { HealthEvent } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditTarget } from "./http-types.js";

type HealthScopedResource = Pick<HealthEvent, "nodeId" | "recordingId" | "scheduleId">;

export async function visibleHealthEvent(
  user: NonNullable<AuthResult["user"]>,
  event: HealthScopedResource,
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>,
) {
  const targets = healthEventTargets(event);

  if (targets.length === 0) {
    return true;
  }

  for (const target of targets) {
    if (await hasResourceScope(user, target)) {
      return true;
    }
  }

  return false;
}

export function healthEventTargets(event: HealthScopedResource): AuditTarget[] {
  const targets: AuditTarget[] = [];

  if (event.recordingId) {
    targets.push({ id: event.recordingId, type: "recording" });
  }

  if (event.scheduleId) {
    targets.push({ id: event.scheduleId, type: "schedule" });
  }

  if (event.nodeId) {
    targets.push({ id: event.nodeId, type: "node" });
  }

  return targets;
}
