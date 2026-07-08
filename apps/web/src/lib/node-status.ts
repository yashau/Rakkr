import type { NodeStatus } from "@rakkr/shared";

import { toneBadgeClass } from "@/lib/status-colors";

// Human-facing label for a node status. The API/enum values are lowercase
// machine tokens ("provisioning", "alerting"); surface a Title Case label rather
// than the raw token in operator-facing badges (audit H2-STATUS-RAW).
const nodeStatusLabels: Record<NodeStatus, string> = {
  alerting: "Alerting",
  degraded: "Degraded",
  offline: "Offline",
  online: "Online",
  provisioning: "Provisioning",
  recording: "Recording",
};

export function nodeStatusLabel(status: NodeStatus | undefined): string {
  if (!status) {
    return "Unknown";
  }

  return nodeStatusLabels[status] ?? status;
}

export function nodeStatusBadgeClass(status: NodeStatus | undefined) {
  switch (status) {
    case "online":
      return toneBadgeClass("healthy");
    // Enrolled but awaiting first contact — informational, not an alarm.
    case "provisioning":
    case "recording":
      return toneBadgeClass("info");
    case "degraded":
      return toneBadgeClass("warning");
    // Offline is a hard failure for a recording node: a room that should be
    // capturing is not. Operators chose for it to read as critical (red) — the
    // same weight as an active alert — not a quiet neutral grey (audit R3-1).
    case "offline":
    case "alerting":
      return toneBadgeClass("critical");
    default:
      return toneBadgeClass("neutral");
  }
}
