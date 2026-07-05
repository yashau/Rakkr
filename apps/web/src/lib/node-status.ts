import type { NodeStatus } from "@rakkr/shared";

import { toneBadgeClass } from "@/lib/status-colors";

export function nodeStatusBadgeClass(status: NodeStatus | undefined) {
  if (status === "online") {
    return toneBadgeClass("healthy");
  }

  // Enrolled but awaiting first contact — informational, not an alarm.
  if (status === "provisioning") {
    return toneBadgeClass("info");
  }

  if (status === "recording") {
    return toneBadgeClass("info");
  }

  if (status === "degraded") {
    return toneBadgeClass("warning");
  }

  if (status === "alerting") {
    return toneBadgeClass("critical");
  }

  return toneBadgeClass("neutral");
}
