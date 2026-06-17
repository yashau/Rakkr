import type {
  AuditEvent,
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

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  auditEvents: () => fetchJson<{ data: AuditEvent[] }>("/api/v1/audit-events"),
  meterFrame: (nodeId: string) => fetchJson<{ data: MeterFrame }>(`/api/v1/nodes/${nodeId}/meters`),
  nodes: () => fetchJson<{ data: RecorderNode[] }>("/api/v1/nodes"),
  recordings: () => fetchJson<{ data: RecordingSummary[] }>("/api/v1/recordings"),
  schedules: () => fetchJson<{ data: ScheduleSummary[] }>("/api/v1/schedules"),
  startListen: (nodeId: string) =>
    fetchJson<{ data: { sessionId: string; startedAt: string } }>(
      `/api/v1/nodes/${nodeId}/listen`,
      {
        method: "POST",
      },
    ),
  startRecording: () =>
    fetchJson<{ data: RecordingSummary }>("/api/v1/recordings", {
      method: "POST",
    }),
  status: () => fetchJson<ControllerStatus>("/api/v1/status"),
  stopRecording: (recordingId: string) =>
    fetchJson<{ data: RecordingSummary }>(`/api/v1/recordings/${recordingId}/stop`, {
      method: "POST",
    }),
};
