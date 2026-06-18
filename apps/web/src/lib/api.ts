import type {
  AuditEvent,
  AuditOutcome,
  AccessPolicy,
  AccessPolicyInput,
  CurrentUser,
  MeterFrame,
  RecorderNode,
  RecordingProfile,
  RecordingJob,
  RecordingSummary,
  ResourceGrant,
  Role,
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

export interface RecordingDownloadTicket {
  downloadId: string;
  expiresAt: string;
  fileName: string;
  mode: "controller_cache";
  recordingId: string;
  url: string;
}

export interface RecordingPlaybackSession {
  mode: "controller_cache";
  recordingId: string;
  sessionId: string;
  startedAt: string;
  streamUrl: string;
}

export interface RecordingFileBlob {
  blob: Blob;
  fileName: string;
}

export interface RecordingMetadataUpdate {
  folder?: string;
  name?: string;
  tags?: string[];
}

export interface RecordingFilters {
  folder?: string;
  healthStatus?: RecordingSummary["healthStatus"];
  nodeId?: string;
  scheduleId?: string;
  search?: string;
  status?: RecordingSummary["status"];
  tag?: string;
}

export interface UserAccessUpdate {
  resourceGrants: ResourceGrant[];
  roles: Role[];
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

async function fetchBlob(path: string, init?: RequestInit): Promise<RecordingFileBlob> {
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

  return {
    blob: await response.blob(),
    fileName: fileNameFromDisposition(response.headers.get("Content-Disposition")),
  };
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
  accessPolicies: () => fetchJson<{ data: AccessPolicy[] }>("/api/v1/auth/access-policies"),
  auditEvents: (filters: AuditEventFilters = {}) =>
    fetchJson<{ data: AuditEvent[] }>(withQuery("/api/v1/audit-events", filters)),
  accessUsers: () => fetchJson<{ data: CurrentUser[] }>("/api/v1/auth/users"),
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
  prepareRecordingDownload: (recordingId: string) =>
    fetchJson<{ data: RecordingDownloadTicket }>(`/api/v1/recordings/${recordingId}/download`, {
      method: "POST",
    }),
  recordingJobs: () => fetchJson<{ data: RecordingJob[] }>("/api/v1/recording-jobs"),
  recordings: (filters: RecordingFilters = {}) =>
    fetchJson<{ data: RecordingSummary[] }>(withQuery("/api/v1/recordings", filters)),
  recordingFile: (recordingId: string) => fetchBlob(`/api/v1/recordings/${recordingId}/file`),
  recordingStream: (recordingId: string) => fetchBlob(`/api/v1/recordings/${recordingId}/stream`),
  schedules: () => fetchJson<{ data: ScheduleSummary[] }>("/api/v1/schedules"),
  startPlayback: (recordingId: string) =>
    fetchJson<{ data: RecordingPlaybackSession }>(`/api/v1/recordings/${recordingId}/playback`, {
      method: "POST",
    }),
  startListen: (nodeId: string) =>
    fetchJson<{ data: { sessionId: string; startedAt: string } }>(
      `/api/v1/nodes/${nodeId}/listen`,
      {
        method: "POST",
      },
    ),
  startRecording: () =>
    fetchJson<{ data: RecordingSummary; job: RecordingJob }>("/api/v1/recordings", {
      method: "POST",
    }),
  status: () => fetchJson<ControllerStatus>("/api/v1/status"),
  stopRecording: (recordingId: string) =>
    fetchJson<{ data: RecordingSummary }>(`/api/v1/recordings/${recordingId}/stop`, {
      method: "POST",
    }),
  updateRecordingMetadata: (recordingId: string, input: RecordingMetadataUpdate) =>
    fetchJson<{ data: RecordingSummary }>(`/api/v1/recordings/${recordingId}/metadata`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  updateAccessPolicies: (policies: AccessPolicyInput[]) =>
    fetchJson<{ data: AccessPolicy[] }>("/api/v1/auth/access-policies", {
      body: JSON.stringify({ policies }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  updateUserAccess: (userId: string, access: UserAccessUpdate) =>
    fetchJson<{ data: CurrentUser }>(`/api/v1/auth/users/${userId}/access`, {
      body: JSON.stringify(access),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
};

function withQuery(path: string, filters: object) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters) as Array<[string, string | undefined]>) {
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();

  return query ? `${path}?${query}` : path;
}

function fileNameFromDisposition(disposition: string | null) {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");

  return match?.[1] ?? "recording.mp3";
}
