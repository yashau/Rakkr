import type {
  AuditEvent,
  AuditOutcome,
  ChannelMapTemplate,
  ChannelMapAssignmentPlan,
  ChannelMapAssignmentPlanInput,
  ChannelMapTemplateAssignment,
  ChannelMapTemplateAssignmentBulkInput,
  ChannelMapTemplateAssignmentInput,
  ChannelMapTemplateAssignmentRollbackInput,
  ChannelMapTemplateInput,
  ChannelMapTemplateUpdate,
  AccessGroup,
  AccessPolicy,
  AccessPolicyInput,
  CurrentUser,
  HealthEvent,
  MeterFrame,
  NodeStatus,
  NodeRuntime,
  RecorderNode,
  OidcPublicConfig,
  Permission,
  RecordingProfile,
  RecordingProfileUpdate,
  RecordingJob,
  RecordingSummary,
  RetentionPolicy,
  RetentionPolicyInput,
  RetentionPolicyUpdate,
  ResourceGrant,
  Role,
  ScheduleInput,
  ScheduleOccurrencePreview,
  ScheduleSummary,
  ScheduleUpdate,
  UploadProvider,
  UploadProviderConfigUpdate,
  UploadProviderRuntimeStatus,
  UploadPolicy,
  UploadPolicyInput,
  UploadPolicyUpdate,
  UploadQueueItem,
  UploadQueueRunSummary,
  UploadRunnerStatus,
  WatchdogPolicy,
  WatchdogPolicyUpdate,
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
  limit?: number;
  outcome?: AuditOutcome;
  permission?: Permission;
  reason?: string;
  target?: string;
  to?: string;
}

export interface NodeFilters {
  q?: string;
  status?: NodeStatus;
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

export interface ListenMonitorSession {
  mode: "agent_audio_chunk" | "controller_meter_preview";
  nodeId: string;
  sessionId: string;
  startedAt: string;
  streamUrl: string;
  targetLatencyMs: number;
}

export interface RecordingFileBlob {
  blob: Blob;
  fileName: string;
}

export interface RecordingMetadataUpdate {
  folder?: string;
  name?: string;
  notes?: string | null;
  tags?: string[];
}

export interface RecordingBulkMetadataUpdate {
  addTags?: string[];
  folder?: string;
  recordingIds: string[];
  removeTags?: string[];
  replaceTags?: string[];
}

export interface RecordingBulkDeleteInput {
  recordingIds: string[];
}

export interface RecordingSelectedExportInput {
  recordingIds: string[];
}

export interface RecordingBulkUploadQueueInput extends UploadQueueInput {
  recordingIds: string[];
}

export interface RecordingStartInput {
  folder?: string;
  name?: string;
  nodeId: string;
  recordingProfileId?: string;
  tags?: string[];
  uploadPolicyId?: string;
}

export interface UploadQueueInput {
  provider?: UploadProvider;
  reason?: string;
  target?: string;
  uploadPolicyId?: string;
}

export interface UploadQueueFilters {
  provider?: UploadProvider;
  recordingId?: string;
  status?: UploadQueueItem["status"];
}

export interface RecordingFilters {
  cacheState?: RecordingCacheState;
  folder?: string;
  healthStatus?: RecordingSummary["healthStatus"];
  limit?: number;
  nodeId?: string;
  offset?: number;
  recordedFrom?: string;
  recordedTo?: string;
  recordingProfileId?: string;
  scheduleId?: string;
  search?: string;
  sortBy?: RecordingSortBy;
  sortOrder?: RecordingSortOrder;
  status?: RecordingSummary["status"];
  tag?: string;
  trackGroupId?: string;
  uploadPolicyId?: string;
}

export type RecordingSortBy =
  | "durationSeconds"
  | "folder"
  | "healthStatus"
  | "name"
  | "recordedAt"
  | "source"
  | "status";
export type RecordingSortOrder = "asc" | "desc";
export type RecordingCacheState = "cached" | "missing";

export interface RecordingListMeta {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  limit?: number;
  offset: number;
  returned: number;
  total: number;
}

export interface RecordingListResponse {
  data: RecordingSummary[];
  meta: RecordingListMeta;
}

export interface RecordingFacet {
  count: number;
  value: string;
}

export interface RecordingFacets {
  folders: RecordingFacet[];
  nodes: RecordingFacet[];
  recordingProfiles: RecordingFacet[];
  tags: RecordingFacet[];
  trackGroups: RecordingFacet[];
  uploadPolicies: RecordingFacet[];
}

export interface HealthEventFilters {
  limit?: number;
  nodeId?: string;
  recordingId?: string;
  scheduleId?: string;
  severity?: HealthEvent["severity"];
  status?: HealthEvent["status"];
  type?: string;
}

export interface HealthEventCreateInput {
  details?: Record<string, unknown>;
  nodeId?: string;
  openedAt?: string;
  recordingId?: string;
  scheduleId?: string;
  severity: HealthEvent["severity"];
  type: string;
}

export interface HealthEventLifecycleInput {
  note?: string;
  suppressedUntil?: string;
}

export interface UserAccessUpdate {
  groupIds: string[];
  resourceGrants: ResourceGrant[];
  roles: Role[];
}

export interface LocalUserCreateInput extends UserAccessUpdate {
  email: string;
  name: string;
  password: string;
}

export interface UserPasswordResetInput {
  password: string;
}

export interface NodeEnrollmentInput {
  agentVersion: string;
  alias: string;
  hostname: string;
  interfaces: Array<{
    alias: string;
    backend: "alsa" | "jack" | "pipewire" | "unknown";
    channelCount: number;
    channels: Array<{
      alias: string;
      index: number;
    }>;
    hardwarePath?: string;
    sampleRates: number[];
    serialNumber?: string;
    systemName: string;
    systemRef?: string;
  }>;
  ipAddresses: string[];
  location: {
    building?: string;
    floor?: string;
    room: string;
    site: string;
  };
  notes?: string;
  recordingCapacity?: {
    maxConcurrentRecordings: number;
  };
  runtime?: NodeRuntime;
  tags: string[];
}

export interface NodeEnrollmentResult {
  credential: {
    createdAt: string;
    id: string;
    nodeId: string;
    token: string;
    tokenPrefix: string;
  };
  node: RecorderNode;
}

export interface NodeMetadataUpdate {
  alias?: string;
  hostname?: string;
  ipAddresses?: string[];
  location?: {
    building?: string | null;
    floor?: string | null;
    room?: string;
    site?: string;
  };
  notes?: string | null;
  recordingCapacity?: {
    maxConcurrentRecordings: number;
  };
  tags?: string[];
}

export interface NodeInterfaceMetadataUpdate {
  alias?: string;
  channels?: Array<{
    alias: string;
    index: number;
  }>;
  hardwarePath?: string | null;
  sampleRates?: number[];
  serialNumber?: string | null;
  systemName?: string;
  systemRef?: string;
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

export function consumeOidcCallbackToken() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("rakkr_token");

  if (!token) {
    return undefined;
  }

  setAuthToken(token);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

  return token;
}

export function setAuthToken(token: string) {
  window.localStorage.setItem(authTokenKey, token);
}

export function clearAuthToken() {
  window.localStorage.removeItem(authTokenKey);
}

export const api = {
  accessGroups: () => fetchJson<{ data: AccessGroup[] }>("/api/v1/auth/groups"),
  accessPolicies: () => fetchJson<{ data: AccessPolicy[] }>("/api/v1/auth/access-policies"),
  auditEvents: (filters: AuditEventFilters = {}) =>
    fetchJson<{ data: AuditEvent[] }>(withQuery("/api/v1/audit-events", filters)),
  auditEventsExport: (filters: AuditEventFilters = {}) =>
    fetchBlob(withQuery("/api/v1/audit-events/export", filters)),
  healthEvents: (filters: HealthEventFilters = {}) =>
    fetchJson<{ data: HealthEvent[] }>(withQuery("/api/v1/health-events", filters)),
  createHealthEvent: (input: HealthEventCreateInput) =>
    fetchJson<{ data: HealthEvent }>("/api/v1/health-events", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  updateHealthEventLifecycle: (
    eventId: string,
    action: "acknowledge" | "reopen" | "resolve" | "suppress",
    input: HealthEventLifecycleInput = {},
  ) =>
    fetchJson<{ data: HealthEvent }>(`/api/v1/health-events/${eventId}/${action}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  accessUsers: () => fetchJson<{ data: CurrentUser[] }>("/api/v1/auth/users"),
  createLocalUser: (input: LocalUserCreateInput) =>
    fetchJson<{ data: CurrentUser }>("/api/v1/auth/users", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  deleteLocalUser: (userId: string) =>
    fetchJson<void>(`/api/v1/auth/users/${userId}`, {
      method: "DELETE",
    }),
  currentUser: () => fetchJson<{ data: CurrentUser }>("/api/v1/auth/me"),
  oidcConfig: () => fetchJson<{ data: OidcPublicConfig }>("/api/v1/auth/oidc/config"),
  oidcLoginUrl: (returnTo = window.location.href) => {
    const url = new URL(`${apiBase}/api/v1/auth/oidc/login`, window.location.origin);

    url.searchParams.set("returnTo", returnTo);

    return url.href;
  },
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
  enrollNode: (input: NodeEnrollmentInput) =>
    fetchJson<{ data: NodeEnrollmentResult }>("/api/v1/nodes/enroll", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  nodes: (filters: NodeFilters = {}) =>
    fetchJson<{ data: RecorderNode[] }>(withQuery("/api/v1/nodes", filters)),
  prepareRecordingDownload: (recordingId: string) =>
    fetchJson<{ data: RecordingDownloadTicket }>(`/api/v1/recordings/${recordingId}/download`, {
      method: "POST",
    }),
  recordingJobs: () => fetchJson<{ data: RecordingJob[] }>("/api/v1/recording-jobs"),
  recordingProfiles: () =>
    fetchJson<{ data: RecordingProfile[] }>("/api/v1/settings/recording-profiles"),
  uploadProviders: () =>
    fetchJson<{ data: UploadProviderRuntimeStatus[] }>("/api/v1/settings/upload-providers"),
  uploadPolicies: () => fetchJson<{ data: UploadPolicy[] }>("/api/v1/settings/upload-policies"),
  retentionPolicies: () =>
    fetchJson<{ data: RetentionPolicy[] }>("/api/v1/settings/retention-policies"),
  watchdogPolicies: () =>
    fetchJson<{ data: WatchdogPolicy[] }>("/api/v1/settings/watchdog-policies"),
  channelMapTemplates: () =>
    fetchJson<{ data: ChannelMapTemplate[] }>("/api/v1/settings/channel-map-templates"),
  channelMapAssignments: () =>
    fetchJson<{ data: ChannelMapTemplateAssignment[] }>("/api/v1/settings/channel-map-assignments"),
  channelMapAssignmentPlans: () =>
    fetchJson<{ data: ChannelMapAssignmentPlan[] }>(
      "/api/v1/settings/channel-map-assignment-plans",
    ),
  createChannelMapTemplate: (input: ChannelMapTemplateInput) =>
    fetchJson<{ data: ChannelMapTemplate }>("/api/v1/settings/channel-map-templates", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  updateChannelMapTemplate: (templateId: string, input: ChannelMapTemplateUpdate) =>
    fetchJson<{ data: ChannelMapTemplate }>(
      `/api/v1/settings/channel-map-templates/${templateId}`,
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      },
    ),
  assignChannelMapTemplate: (input: ChannelMapTemplateAssignmentInput) =>
    fetchJson<{ data: ChannelMapTemplateAssignment }>("/api/v1/settings/channel-map-assignments", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PUT",
    }),
  bulkAssignChannelMapTemplate: (input: ChannelMapTemplateAssignmentBulkInput) =>
    fetchJson<{ data: ChannelMapTemplateAssignment[] }>(
      "/api/v1/settings/channel-map-assignments/bulk",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PUT",
      },
    ),
  createChannelMapAssignmentPlan: (input: ChannelMapAssignmentPlanInput) =>
    fetchJson<{ data: ChannelMapAssignmentPlan }>("/api/v1/settings/channel-map-assignment-plans", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  applyChannelMapAssignmentPlan: (planId: string) =>
    fetchJson<{
      data: {
        assignments: ChannelMapTemplateAssignment[];
        plan: ChannelMapAssignmentPlan | undefined;
      };
    }>(`/api/v1/settings/channel-map-assignment-plans/${planId}/apply`, {
      method: "POST",
    }),
  rollbackChannelMapAssignment: (input: ChannelMapTemplateAssignmentRollbackInput) =>
    fetchJson<{ data: ChannelMapTemplateAssignment }>(
      "/api/v1/settings/channel-map-assignments/rollback",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
  updateRecordingProfile: (profileId: string, input: RecordingProfileUpdate) =>
    fetchJson<{ data: RecordingProfile }>(`/api/v1/settings/recording-profiles/${profileId}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  updateUploadProvider: (provider: UploadProvider, input: UploadProviderConfigUpdate) =>
    fetchJson<{ data: UploadProviderRuntimeStatus }>(
      `/api/v1/settings/upload-providers/${provider}`,
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      },
    ),
  createUploadPolicy: (input: UploadPolicyInput) =>
    fetchJson<{ data: UploadPolicy }>("/api/v1/settings/upload-policies", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  updateUploadPolicy: (policyId: string, input: UploadPolicyUpdate) =>
    fetchJson<{ data: UploadPolicy }>(`/api/v1/settings/upload-policies/${policyId}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  createRetentionPolicy: (input: RetentionPolicyInput) =>
    fetchJson<{ data: RetentionPolicy }>("/api/v1/settings/retention-policies", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  updateRetentionPolicy: (policyId: string, input: RetentionPolicyUpdate) =>
    fetchJson<{ data: RetentionPolicy }>(`/api/v1/settings/retention-policies/${policyId}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  updateWatchdogPolicy: (policyId: string, input: WatchdogPolicyUpdate) =>
    fetchJson<{ data: WatchdogPolicy }>(`/api/v1/settings/watchdog-policies/${policyId}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  recordings: (filters: RecordingFilters = {}) =>
    fetchJson<RecordingListResponse>(withQuery("/api/v1/recordings", filters)),
  exportRecordingManifest: (filters: RecordingFilters = {}) =>
    fetchBlob(withQuery("/api/v1/recordings/export", filters)),
  exportSelectedRecordingManifest: (input: RecordingSelectedExportInput) =>
    fetchBlob("/api/v1/recordings/export", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  recordingFacets: () => fetchJson<{ data: RecordingFacets }>("/api/v1/recordings/facets"),
  deleteRecording: (recordingId: string) =>
    fetchJson<void>(`/api/v1/recordings/${recordingId}`, {
      method: "DELETE",
    }),
  deleteRecordings: (input: RecordingBulkDeleteInput) =>
    fetchJson<{
      data: RecordingSummary[];
      meta: { cacheDeletedCount: number; deletedCount: number };
    }>("/api/v1/recordings/bulk-delete", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  uploadQueue: (filters: UploadQueueFilters = {}) =>
    fetchJson<{ data: UploadQueueItem[] }>(withQuery("/api/v1/upload-queue", filters)),
  uploadRunner: () => fetchJson<{ data: UploadRunnerStatus }>("/api/v1/upload-runner"),
  runUploadRunner: () =>
    fetchJson<{ data: UploadRunnerStatus; summary: UploadQueueRunSummary }>(
      "/api/v1/upload-runner/run",
      {
        method: "POST",
      },
    ),
  enqueueRecordingUpload: (recordingId: string, input: UploadQueueInput = {}) =>
    fetchJson<{ data: UploadQueueItem }>(`/api/v1/recordings/${recordingId}/upload-queue`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  enqueueRecordingsUpload: (input: RecordingBulkUploadQueueInput) =>
    fetchJson<{ data: UploadQueueItem[]; meta: { queuedCount: number } }>(
      "/api/v1/recordings/bulk-upload-queue",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
  retryUploadQueueItem: (itemId: string) =>
    fetchJson<{ data: UploadQueueItem }>(`/api/v1/upload-queue/${itemId}/retry`, {
      method: "POST",
    }),
  recordingFile: (recordingId: string) => fetchBlob(`/api/v1/recordings/${recordingId}/file`),
  recordingStream: (recordingId: string) => fetchBlob(`/api/v1/recordings/${recordingId}/stream`),
  runScheduleNow: (scheduleId: string) =>
    fetchJson<{ data: RecordingSummary; job: RecordingJob }>(
      `/api/v1/schedules/${scheduleId}/run-now`,
      {
        method: "POST",
      },
    ),
  skipScheduleNext: (scheduleId: string) =>
    fetchJson<{ data: ScheduleSummary }>(`/api/v1/schedules/${scheduleId}/skip-next`, {
      method: "POST",
    }),
  scheduleOccurrences: (scheduleId: string, limit = 5) =>
    fetchJson<{ data: ScheduleOccurrencePreview[] }>(
      withQuery(`/api/v1/schedules/${scheduleId}/occurrences`, { limit }),
    ),
  schedules: () => fetchJson<{ data: ScheduleSummary[] }>("/api/v1/schedules"),
  startPlayback: (recordingId: string) =>
    fetchJson<{ data: RecordingPlaybackSession }>(`/api/v1/recordings/${recordingId}/playback`, {
      method: "POST",
    }),
  startListen: (nodeId: string) =>
    fetchJson<{ data: ListenMonitorSession }>(`/api/v1/nodes/${nodeId}/listen`, {
      method: "POST",
    }),
  listenStream: (streamUrl: string) => fetchBlob(streamUrl),
  rotateNodeCredential: (nodeId: string) =>
    fetchJson<{ data: NodeEnrollmentResult }>(`/api/v1/nodes/${nodeId}/credentials/rotate`, {
      method: "POST",
    }),
  updateNode: (nodeId: string, input: NodeMetadataUpdate) =>
    fetchJson<{ data: RecorderNode }>(`/api/v1/nodes/${nodeId}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  updateNodeInterface: (nodeId: string, interfaceId: string, input: NodeInterfaceMetadataUpdate) =>
    fetchJson<{ data: RecorderNode }>(`/api/v1/nodes/${nodeId}/interfaces/${interfaceId}`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  createSchedule: (input: ScheduleInput) =>
    fetchJson<{ data: ScheduleSummary }>("/api/v1/schedules", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  deleteSchedule: (scheduleId: string) =>
    fetchJson<void>(`/api/v1/schedules/${scheduleId}`, {
      method: "DELETE",
    }),
  startRecording: (input: RecordingStartInput) =>
    fetchJson<{ data: RecordingSummary; job: RecordingJob }>("/api/v1/recordings", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
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
  updateRecordingBulkMetadata: (input: RecordingBulkMetadataUpdate) =>
    fetchJson<{ data: RecordingSummary[]; meta: { updatedCount: number } }>(
      "/api/v1/recordings/bulk-metadata",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      },
    ),
  updateSchedule: (scheduleId: string, input: ScheduleUpdate) =>
    fetchJson<{ data: ScheduleSummary }>(`/api/v1/schedules/${scheduleId}`, {
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
  resetUserPassword: (userId: string, input: UserPasswordResetInput) =>
    fetchJson<{ data: CurrentUser }>(`/api/v1/auth/users/${userId}/password`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
  updateUserStatus: (userId: string, disabled: boolean) =>
    fetchJson<{ data: CurrentUser }>(`/api/v1/auth/users/${userId}/status`, {
      body: JSON.stringify({ disabled }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    }),
};

function withQuery(path: string, filters: object) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters) as Array<
    [string, number | string | undefined]
  >) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }

  const query = params.toString();

  return query ? `${path}?${query}` : path;
}

function fileNameFromDisposition(disposition: string | null) {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");

  return match?.[1] ?? "recording.mp3";
}
