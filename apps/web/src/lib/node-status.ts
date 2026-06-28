import type { NodeStatus } from "@rakkr/shared";

import { toneBadgeClass } from "@/lib/status-colors";

export function nodeStatusBadgeClass(status: NodeStatus | undefined) {
  if (status === "online") {
    return toneBadgeClass("healthy");
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
