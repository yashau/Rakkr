import type { CurrentUser, RecorderNode } from "@rakkr/shared";

export function dashboardPagePermissions(user: CurrentUser | undefined) {
  const canRead = user?.permissions.includes("node:read") ?? false;

  return {
    canRead,
    canReadMeters: canRead,
  };
}

export function dashboardSelectedNodeId(selectedNodeId: string, nodes: Pick<RecorderNode, "id">[]) {
  if (nodes.some((node) => node.id === selectedNodeId)) {
    return selectedNodeId;
  }

  return nodes[0]?.id ?? "";
}
