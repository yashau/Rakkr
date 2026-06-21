import type { CurrentUser, HealthEvent, RecorderNode, RecordingJob } from "@rakkr/shared";

export type DashboardIncidentAction = "acknowledge" | "resolve";

export function dashboardPagePermissions(user: CurrentUser | undefined) {
  const permissions = user?.permissions ?? [];
  const canRead = permissions.includes("node:read");

  return {
    canAcknowledgeHealth: permissions.includes("health:acknowledge"),
    canControlRecordings: permissions.includes("recording:control"),
    canCreateRecordings: permissions.includes("recording:create"),
    canRead,
    canReadHealth: permissions.includes("health:read"),
    canReadMeters: canRead,
    canReadRecordings: permissions.includes("recording:read"),
    canReadSettings: permissions.includes("settings:read"),
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

export function dashboardActiveRecordingJobs(jobs: RecordingJob[], limit = 4) {
  return jobs
    .filter((job) => activeRecordingJobStatuses.includes(job.status))
    .sort((left, right) => {
      const statusDelta =
        recordingJobStatusRank(right.status) - recordingJobStatusRank(left.status);

      if (statusDelta !== 0) {
        return statusDelta;
      }

      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    })
    .slice(0, limit);
}

export function dashboardIncidentActions(status: HealthEvent["status"]): DashboardIncidentAction[] {
  if (status === "resolved") {
    return [];
  }

  if (status === "open") {
    return ["acknowledge", "resolve"];
  }

  return ["resolve"];
}

const activeRecordingJobStatuses: Array<RecordingJob["status"]> = [
  "queued",
  "running",
  "stop_requested",
];

function recordingJobStatusRank(status: RecordingJob["status"]) {
  if (status === "running") {
    return 3;
  }

  if (status === "queued") {
    return 2;
  }

  if (status === "stop_requested") {
    return 1;
  }

  return 0;
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
