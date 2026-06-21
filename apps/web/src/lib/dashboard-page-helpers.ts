import type { CurrentUser, HealthEvent, RecorderNode } from "@rakkr/shared";

export function dashboardPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];
  const canRead = permissions.includes("node:read");

  return {
    canRead,
    canReadHealth: permissions.includes("health:read"),
    canReadMeters: canRead,
  };
}

export function dashboardSelectedNodeId(selectedNodeId: string, nodes: Pick<RecorderNode, "id">[]) {
  if (nodes.some((node) => node.id === selectedNodeId)) {
    return selectedNodeId;
  }

  return nodes[0]?.id ?? "";
}

export function dashboardActiveHealthEvents(events: HealthEvent[], limit = 4) {
  return events
    .filter((event) => event.status !== "resolved")
    .sort((left, right) => {
      const severityDelta = severityRank(right.severity) - severityRank(left.severity);

      if (severityDelta !== 0) {
        return severityDelta;
      }

      return Date.parse(right.openedAt) - Date.parse(left.openedAt);
    })
    .slice(0, limit);
}

function severityRank(severity: HealthEvent["severity"]) {
  if (severity === "critical") {
    return 3;
  }

  if (severity === "warning") {
    return 2;
  }

  return 1;
}
