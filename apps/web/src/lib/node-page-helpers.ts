import type { HealthEventStatus, NodeRuntime, Permission } from "@rakkr/shared";

import type { NodeFilters } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

export type ListenMonitorMode = "agent_audio_chunk" | "controller_meter_preview";
export type NodeFilterKey = keyof NodeFilters;
export type NodeHealthLifecycleAction = "acknowledge" | "reopen" | "resolve" | "suppress";

export interface ActiveNodeFilterChip {
  key: NodeFilterKey;
  label: string;
  value: string;
}

export interface NodePageActionPermissions {
  canRead: boolean;
  canReadHealth: boolean;
  canAcknowledgeHealth: boolean;
  canListen: boolean;
  canManage: boolean;
}

/**
 * Page size for node pickers and id->label lookups (recording start, schedules,
 * jobs, dashboard, health, recordings, settings). These callers need the whole
 * scoped node inventory, not a page: `api.nodes()` with no `limit` gets the
 * server default (50), silently dropping the 51st+ node from dropdowns and
 * leaving its recordings/jobs unlabeled. 200 is the API's max page size
 * (`PAGE_POLICY.default.maxLimit`); requesting it fetches the full inventory up
 * to that cap. Deployments beyond 200 nodes need a paginated picker (tracked).
 */
export const NODE_PICKER_LIMIT = 200;

/** Query filters for node pickers/labels — fetch the full inventory, not a page. */
export function nodePickerFilters(): { limit: number } {
  return { limit: NODE_PICKER_LIMIT };
}

export function nodePageActionPermissions(permissions: readonly Permission[]) {
  return {
    canRead: permissions.includes("node:read"),
    canReadHealth: permissions.includes("health:read"),
    canAcknowledgeHealth: permissions.includes("health:acknowledge"),
    canListen: permissions.includes("listen:monitor"),
    canManage: permissions.includes("node:manage"),
  } satisfies NodePageActionPermissions;
}

export function nodeSelectionState(
  nodes: readonly { id: string }[],
  selectedNodeIds: readonly string[],
) {
  const visibleNodeIds = nodes.map((node) => node.id);
  const selectedVisibleNodeIds = selectedNodeIds.filter((nodeId) =>
    visibleNodeIds.includes(nodeId),
  );

  return {
    allVisibleSelected:
      visibleNodeIds.length > 0 &&
      visibleNodeIds.every((nodeId) => selectedNodeIds.includes(nodeId)),
    selectedVisibleNodeIds,
    visibleNodeIds,
  };
}

export function nextNodeSelection(
  selectedNodeIds: readonly string[],
  nodeId: string,
  selected: boolean,
) {
  if (!selected) {
    return selectedNodeIds.filter((candidate) => candidate !== nodeId);
  }

  return selectedNodeIds.includes(nodeId) ? [...selectedNodeIds] : [...selectedNodeIds, nodeId];
}

export function nodeLocationSummary(location: {
  building?: string;
  floor?: string;
  room: string;
  site: string;
}) {
  return [location.site, location.building, location.floor, location.room]
    .filter(Boolean)
    .join(" / ");
}

export function nodeRuntimeSummary(runtime: NodeRuntime) {
  return [
    runtime.osName,
    runtime.kernelRelease ? `kernel ${runtime.kernelRelease}` : undefined,
    runtime.architecture,
    runtime.audioBackends.length > 0 ? runtime.audioBackends.join(", ") : undefined,
    runtime.uptimeSeconds === undefined ? undefined : `uptime ${nodeUptime(runtime.uptimeSeconds)}`,
  ]
    .filter(Boolean)
    .join(" / ");
}

export function nodeFilterChips(filters: NodeFilters): ActiveNodeFilterChip[] {
  return nodeFilterOrder.flatMap((key) => {
    const value = filters[key];

    if (!value) {
      return [];
    }

    return [
      {
        key,
        label: nodeFilterLabels[key],
        value: nodeFilterValue(key, value),
      },
    ];
  });
}

export function rotateNodeTokenTitle(canManage: boolean, isPersistedNode: boolean) {
  if (!canManage) {
    return "Requires node manage";
  }

  return isPersistedNode ? "Rotate node token" : "Demo node tokens are not persisted";
}

export function listenMonitorModeLabel(mode: ListenMonitorMode) {
  return mode === "agent_audio_chunk" ? "Agent audio" : "Meter preview";
}

export function listenMonitorPollInterval(targetLatencyMs: number) {
  if (!Number.isFinite(targetLatencyMs)) {
    return 1500;
  }

  return Math.min(Math.max(Math.round(targetLatencyMs), 750), 3000);
}

export const liveListenRenditions = ["raw", "enhanced"] as const;
export type LiveListenRendition = (typeof liveListenRenditions)[number];

export function liveListenRendition(enhance: boolean): LiveListenRendition {
  return enhance ? "enhanced" : "raw";
}

export function liveListenRenditionLabel(rendition: LiveListenRendition) {
  return rendition === "enhanced" ? "Enhanced" : "Raw";
}

export function nodeHealthLifecycleActions(status: HealthEventStatus): NodeHealthLifecycleAction[] {
  if (status === "resolved") {
    return ["reopen"];
  }

  if (status === "open") {
    return ["acknowledge", "suppress", "resolve"];
  }

  if (status === "acknowledged") {
    return ["suppress", "resolve"];
  }

  return ["resolve"];
}

export function defaultNodeHealthSuppressedUntil(now = new Date()) {
  const suppressedUntil = new Date(now);
  suppressedUntil.setHours(suppressedUntil.getHours() + 1);

  return suppressedUntil.toISOString();
}

export function nodeHealthLifecycleInput(eventId: string, action: NodeHealthLifecycleAction) {
  return {
    action,
    eventId,
    suppressedUntil: action === "suppress" ? defaultNodeHealthSuppressedUntil() : undefined,
  };
}

function nodeUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);

  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function nodeFilterValue(key: NodeFilterKey, value: string) {
  if (key === "lastSeenFrom" || key === "lastSeenTo") {
    return formatDateTime(value);
  }

  return value;
}

const nodeFilterOrder: NodeFilterKey[] = [
  "q",
  "status",
  "backend",
  "site",
  "building",
  "floor",
  "room",
  "lastSeenFrom",
  "lastSeenTo",
];

const nodeFilterLabels: Record<NodeFilterKey, string> = {
  backend: "backend",
  building: "building",
  floor: "floor",
  lastSeenFrom: "last seen from",
  lastSeenTo: "last seen to",
  q: "search",
  room: "room",
  site: "site",
  status: "status",
};
