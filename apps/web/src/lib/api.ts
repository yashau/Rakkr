import type {
  MeterFrame,
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
  ScheduleSummary,
  WatchdogPolicy,
} from "@rakkr/shared";

const apiBase = import.meta.env.VITE_API_BASE ?? "";

export interface ControllerStatus {
  activeRecordings: number;
  cachedRecordings: number;
  criticalAlerts: number;
  nodeCount: number;
  onlineNodes: number;
  recordingProfile: RecordingProfile;
  startedAt: string;
  watchdogPolicy: WatchdogPolicy;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  meterFrame: (nodeId: string) => fetchJson<{ data: MeterFrame }>(`/api/v1/nodes/${nodeId}/meters`),
  nodes: () => fetchJson<{ data: RecorderNode[] }>("/api/v1/nodes"),
  recordings: () => fetchJson<{ data: RecordingSummary[] }>("/api/v1/recordings"),
  schedules: () => fetchJson<{ data: ScheduleSummary[] }>("/api/v1/schedules"),
  status: () => fetchJson<ControllerStatus>("/api/v1/status"),
};
