import type {
  CurrentUser,
  HealthEvent,
  HealthEventStatus,
  HealthSeverity,
  RecorderNode,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";

import type { HealthEventFilters } from "@/lib/api";
import { localDateBoundaryIso } from "@/lib/dates";

export type HealthLifecycleAction = "acknowledge" | "reopen" | "resolve" | "suppress";

export interface HealthPageFilterDraft {
  limit: string;
  nodeId: string;
  openedFromDate: string;
  openedToDate: string;
  recordingId: string;
  resolvedFromDate: string;
  resolvedToDate: string;
  scheduleId: string;
  search: string;
  severity: "" | HealthSeverity;
  status: "" | HealthEventStatus;
  type: string;
}

export const emptyHealthPageFilters: HealthPageFilterDraft = {
  limit: "200",
  nodeId: "",
  openedFromDate: "",
  openedToDate: "",
  recordingId: "",
  resolvedFromDate: "",
  resolvedToDate: "",
  scheduleId: "",
  search: "",
  severity: "",
  status: "",
  type: "",
};

export function healthPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];

  return {
    canAcknowledgeHealth: permissions.includes("health:acknowledge"),
    canReadHealth: permissions.includes("health:read"),
    canReadNodes: permissions.includes("node:read"),
    canReadRecordings: permissions.includes("recording:read"),
    canReadSchedules: permissions.includes("schedule:read"),
  };
}

export function healthEventFiltersFromDraft(draft: HealthPageFilterDraft): HealthEventFilters {
  const limit = Number(draft.limit);

  return {
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : undefined,
    nodeId: trimmed(draft.nodeId),
    openedFrom: localDateBoundaryIso(draft.openedFromDate, "start"),
    openedTo: localDateBoundaryIso(draft.openedToDate, "end"),
    recordingId: trimmed(draft.recordingId),
    resolvedFrom: localDateBoundaryIso(draft.resolvedFromDate, "start"),
    resolvedTo: localDateBoundaryIso(draft.resolvedToDate, "end"),
    scheduleId: trimmed(draft.scheduleId),
    search: trimmed(draft.search),
    severity: draft.severity || undefined,
    status: draft.status || undefined,
    type: trimmed(draft.type),
  };
}

export function healthEventSummary(events: HealthEvent[]) {
  return {
    activeCritical: events.filter(
      (event) => event.severity === "critical" && event.status !== "resolved",
    ).length,
    open: events.filter((event) => event.status === "open").length,
    resolved: events.filter((event) => event.status === "resolved").length,
    suppressed: events.filter((event) => event.status === "suppressed").length,
    total: events.length,
  };
}

export function healthEventBulkActionTargets(
  events: HealthEvent[],
  selectedEventIds: string[],
  action: HealthLifecycleAction,
) {
  const selected = new Set(selectedEventIds);

  return events.filter(
    (event) => selected.has(event.id) && healthLifecycleActions(event.status).includes(action),
  );
}

export function healthLifecycleActions(status: HealthEventStatus): HealthLifecycleAction[] {
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

export function healthEventTargetLabel(
  event: HealthEvent,
  lookups: {
    nodes?: RecorderNode[];
    recordings?: RecordingSummary[];
    schedules?: ScheduleSummary[];
  },
) {
  const schedule = event.scheduleId
    ? lookups.schedules?.find((candidate) => candidate.id === event.scheduleId)
    : undefined;
  const recording = event.recordingId
    ? lookups.recordings?.find((candidate) => candidate.id === event.recordingId)
    : undefined;
  const node = event.nodeId
    ? lookups.nodes?.find((candidate) => candidate.id === event.nodeId)
    : undefined;

  return [
    node ? `Node ${node.alias}` : event.nodeId,
    schedule ? `Schedule ${schedule.name}` : event.scheduleId,
    recording ? `Recording ${recording.name}` : event.recordingId,
  ]
    .filter(Boolean)
    .join(" / ");
}

export function readableHealthEventType(type: string) {
  if (type === "watchdog.node_offline") {
    return "node offline";
  }

  if (type === "controller.recording.upload_queue_failed") {
    return "upload queue failed";
  }

  return type
    .replace(/^agent\./u, "")
    .replace(/^watchdog\./u, "")
    .replaceAll("_", " ")
    .replaceAll(".", " ");
}

function trimmed(value: string) {
  const next = value.trim();

  return next || undefined;
}
