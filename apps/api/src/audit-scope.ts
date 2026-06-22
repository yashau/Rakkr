import type { AuditEvent } from "@rakkr/shared";

import type { AuthResult } from "./auth-service.js";
import type { AuditTarget } from "./http-types.js";

interface AuditScopeDependencies {
  allowActorSelf?: boolean;
  hasResourceScope: (
    user: NonNullable<AuthResult["user"]>,
    target: AuditTarget,
  ) => Promise<boolean>;
}

const RESOURCE_SCOPED_AUDIT_TARGET_TYPES = new Set([
  "channel",
  "channel_map_assignment_plan",
  "channel_map_template",
  "health_event",
  "interface",
  "node",
  "recording",
  "recording_profile",
  "retention_policy",
  "room",
  "schedule",
  "upload_policy",
  "upload_provider",
  "watchdog_policy",
]);

export async function canReadAuditEvent(
  user: NonNullable<AuthResult["user"]>,
  event: AuditEvent,
  dependencies: AuditScopeDependencies,
) {
  if (dependencies.allowActorSelf && event.actor.type === "user" && event.actor.id === user.id) {
    return true;
  }

  if (!isResourceScopedAuditTarget(event.target)) {
    return true;
  }

  return dependencies.hasResourceScope(user, event.target);
}

export function isResourceScopedAuditTarget(target: AuditTarget) {
  return Boolean(target.id && RESOURCE_SCOPED_AUDIT_TARGET_TYPES.has(target.type));
}
