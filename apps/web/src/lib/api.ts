import type {
  AuditEvent,
  AuditOutcome,
  CurrentUser,
  MeterFrame,
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
  ScheduleSummary,
  WatchdogPolicy,
} from "@rakkr/shared";

const apiBase = import.meta.env.VITE_API_BASE ?? "";
const authTokenKey = "rakkr.authToken";

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

export interface AuditEventFilters {
  action?: string;
  actor?: string;
  from?: string;
  outcome?: AuditOutcome;
  target?: string;
  to?: string;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function getAuthToken() {
  return window.localStorage.getItem(authTokenKey);
}

export function setAuthToken(token: string) {
  window.localStorage.setItem(authTokenKey, token);
}

export function clearAuthToken() {
  window.localStorage.removeItem(authTokenKey);
}

export const api = {
  auditEvents: (filters: AuditEventFilters = {}) =>
    fetchJson<{ data: AuditEvent[] }>(withQuery("/api/v1/audit-events", filters)),
  currentUser: () => fetchJson<{ data: CurrentUser }>("/api/v1/auth/me"),
  login: (email: string, password: string) =>
    fetchJson<{ data: { expiresAt: string; token: string; user: CurrentUser } }>(
      "/api/v1/auth/login",
      {
        body: JSON.stringify({ email, password }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
  logout: () =>
    fetchJson<void>("/api/v1/auth/logout", {
      method: "POST",
    }),
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

function withQuery(path: string, filters: AuditEventFilters) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();

  return query ? `${path}?${query}` : path;
}
