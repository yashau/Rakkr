import type {
  AuditEvent,
  AuditOutcome,
  AccessPolicy,
  AccessPolicyInput,
  CurrentUser,
  HealthEvent,
  MeterFrame,
  NodeStatus,
  NodeRuntime,
  NodeAudioCommandDefaults,
  RecorderNode,
  OidcPublicConfig,
  PaginatedResponse,
  Permission,
  RecordingChunk,
  RecordingJob,
  RecordingJobStatusSummary,
  RecordingSummary,
  ResourceGrant,
  Role,
  Room,
  RoomInput,
  RoomOverview,
  RoomRosterEntry,
  RoomRosterUpdate,
  RoomUpdate,
  ScheduleCalendarResponse,
  ScheduleInput,
  ScheduleOccurrencePreview,
  ScheduleSummary,
  ScheduleUpdate,
  UploadQueueItem,
  UploadQueueRunSummary,
  UploadRunnerStatus,
} from "@rakkr/shared";
import { accessGroupsApi } from "./access-groups-api";
import { apiBase, fetchBlob, fetchJson, withQuery } from "./api-http";
import { settingsApi } from "./api-settings";
import type { ControllerStatus } from "./status-types";
import type { RecordingStartInput } from "./api-types";

export type { ControllerStatus } from "./status-types";
export { ApiError, apiErrorStatus } from "./api-error";
export type { RecordingFileBlob } from "./api-http";
export { clearAuthToken, consumeOidcCallbackToken, getAuthToken, setAuthToken } from "./api-http";
export type { WatchdogCalibrationInput, WatchdogCalibrationResult } from "./api-types";

export interface AuditEventFilters {
  action?: string;
  actor?: string;
  from?: string;
  limit?: number;
  offset?: number;
  outcome?: AuditOutcome;
  permission?: Permission;
  reason?: string;
  target?: string;
  to?: string;
}

export interface NodeFilters {
  backend?: "alsa" | "jack" | "pipewire" | "unknown";
  building?: string;
  floor?: string;
  lastSeenFrom?: string;
  lastSeenTo?: string;
  q?: string;
  room?: string;
  site?: string;
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
  enhance: boolean;
  mode: "agent_audio_chunk" | "controller_meter_preview";
  nodeId: string;
  sessionId: string;
  startedAt: string;
  stopUrl: string;
  streamUrl: string;
  targetLatencyMs: number;
}

export interface ListenMonitorStoppedSession extends ListenMonitorSession {
  endedAt: string;
}

export interface RecordingMetadataUpdate {
  folder?: string;
  name?: string;
  notes?: string | null;
  tags?: string[];
  transcriptSnippets?: string[] | null;
}

export interface RecordingBulkMetadataUpdate {
  addTags?: string[];
  folder?: string;
  recordingIds: string[];
  removeTags?: string[];
  replaceTags?: string[];
}

export type RecordingBulkDeleteInput = { recordingIds: string[] };

export interface RecordingBulkUploadQueueInput extends UploadQueueInput {
  recordingIds: string[];
}

export interface UploadQueueInput {
  reason?: string;
  uploadPolicyId?: string;
}

export type UploadQueueFilters = Partial<
  Pick<UploadQueueItem, "provider" | "recordingId" | "status">
>;

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

export interface RecordingJobFilters {
  captureBackend?: NonNullable<RecordingJob["command"]["captureBackend"]>;
  captureInterfaceId?: string;
  createdFrom?: string;
  createdTo?: string;
  nodeId?: string;
  search?: string;
  status?: RecordingJob["status"];
}

export type ScheduleFilters = Partial<
  Pick<ScheduleSummary, "captureBackend" | "captureInterfaceId" | "nodeId">
> & { enabled?: "false" | "true"; search?: string };

export interface RecordingJobBulkActionInput {
  jobIds: string[];
}

export type RecordingJobSelectedExportInput = { jobIds: string[] };

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
  offset?: number;
  nodeId?: string;
  openedFrom?: string;
  openedTo?: string;
  recordingId?: string;
  resolvedFrom?: string;
  resolvedTo?: string;
  scheduleId?: string;
  search?: string;
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

export interface HealthEventBulkLifecycleInput extends HealthEventLifecycleInput {
  action: "acknowledge" | "reopen" | "resolve" | "suppress";
  eventIds: string[];
}

export interface HealthEventSelectedExportInput {
  eventIds: string[];
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
  audioDefaults?: NodeAudioCommandDefaults;
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

export const api = {
  ...accessGroupsApi,
  rooms: () => fetchJson<{ data: Room[] }>("/api/v1/rooms"),
  room: (roomId: string) => fetchJson<{ data: Room }>(`/api/v1/rooms/${roomId}`),
  roomOverview: (roomId: string) =>
    fetchJson<{ data: RoomOverview }>(`/api/v1/rooms/${roomId}/overview`),
  roomRoster: (roomId: string) =>
    fetchJson<{ data: RoomRosterEntry[] }>(`/api/v1/rooms/${roomId}/roster`),
  createRoom: (input: RoomInput) =>
    fetchJson<{ data: Room }>("/api/v1/rooms", {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  updateRoom: (roomId: string, input: RoomUpdate) =>
    fetchJson<{ data: Room }>(`/api/v1/rooms/${roomId}`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }),
  deleteRoom: (roomId: string) => fetchJson<void>(`/api/v1/rooms/${roomId}`, { method: "DELETE" }),
  updateRoomRoster: (roomId: string, input: RoomRosterUpdate) =>
    fetchJson<{ data: RoomRosterEntry[] }>(`/api/v1/rooms/${roomId}/roster`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }),
  accessPolicies: () => fetchJson<{ data: AccessPolicy[] }>("/api/v1/auth/access-policies"),
  auditEvents: (filters: AuditEventFilters = {}) =>
    fetchJson<PaginatedResponse<AuditEvent>>(withQuery("/api/v1/audit-events", filters)),
  auditEventsExport: (filters: AuditEventFilters = {}) =>
    fetchBlob(withQuery("/api/v1/audit-events/export", filters)),
  healthEvents: (filters: HealthEventFilters = {}) =>
    fetchJson<PaginatedResponse<HealthEvent>>(withQuery("/api/v1/health-events", filters)),
  healthEventsExport: (filters: HealthEventFilters = {}) =>
    fetchBlob(withQuery("/api/v1/health-events/export", filters)),
  healthEventsExportSelected: (input: HealthEventSelectedExportInput) =>
    fetchBlob("/api/v1/health-events/export", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
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
  updateHealthEventsLifecycle: (input: HealthEventBulkLifecycleInput) =>
    fetchJson<{ data: HealthEvent[]; meta: { updatedCount: number } }>(
      "/api/v1/health-events/bulk-lifecycle",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
  accessUsers: (params: { limit?: number; offset?: number } = {}) =>
    fetchJson<PaginatedResponse<CurrentUser>>(withQuery("/api/v1/auth/users", params)),
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
  node: (nodeId: string) => fetchJson<{ data: RecorderNode }>(`/api/v1/nodes/${nodeId}`),
  nodes: (filters: NodeFilters & { limit?: number; offset?: number } = {}) =>
    fetchJson<PaginatedResponse<RecorderNode>>(withQuery("/api/v1/nodes", filters)),
  nodesExport: (filters: NodeFilters = {}) => fetchBlob(withQuery("/api/v1/nodes/export", filters)),
  nodesExportSelected: (input: { nodeIds: string[] }) =>
    fetchBlob("/api/v1/nodes/export", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  prepareRecordingDownload: (recordingId: string) =>
    fetchJson<{ data: RecordingDownloadTicket }>(`/api/v1/recordings/${recordingId}/download`, {
      method: "POST",
    }),
  recordingJobChunks: (jobId: string) =>
    fetchJson<{ data: RecordingChunk[] }>(`/api/v1/recording-jobs/${jobId}/chunks`),
  recordingJobs: (filters: RecordingJobFilters & { limit?: number; offset?: number } = {}) =>
    fetchJson<PaginatedResponse<RecordingJob> & { summary: RecordingJobStatusSummary }>(
      withQuery("/api/v1/recording-jobs", filters),
    ),
  recordingJobsExport: (filters: RecordingJobFilters = {}) =>
    fetchBlob(withQuery("/api/v1/recording-jobs/export", filters)),
  recordingJobsExportSelected: (input: RecordingJobSelectedExportInput) =>
    fetchBlob("/api/v1/recording-jobs/export", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    }),
  retryRecordingJob: (jobId: string) =>
    fetchJson<{ data: RecordingJob }>(`/api/v1/recording-jobs/${jobId}/retry`, {
      method: "POST",
    }),
  retryRecordingJobs: (input: RecordingJobBulkActionInput) =>
    fetchJson<{ data: RecordingJob[]; meta: { retriedCount: number } }>(
      "/api/v1/recording-jobs/bulk-retry",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
  stopRecordingJobs: (input: RecordingJobBulkActionInput) =>
    fetchJson<{ data: RecordingJob[]; meta: { stoppedCount: number } }>(
      "/api/v1/recording-jobs/bulk-stop",
      {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ),
  ...settingsApi,
  recordings: (filters: RecordingFilters = {}) =>
    fetchJson<RecordingListResponse>(withQuery("/api/v1/recordings", filters)),
  exportRecordingManifest: (filters: RecordingFilters = {}) =>
    fetchBlob(withQuery("/api/v1/recordings/export", filters)),
  exportSelectedRecordingManifest: (input: { recordingIds: string[] }) =>
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
  uploadQueue: (filters: UploadQueueFilters & { limit?: number; offset?: number } = {}) =>
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
  recordingStream: (recordingId: string, rendition?: "enhanced" | "raw") =>
    fetchBlob(
      `/api/v1/recordings/${recordingId}/stream${rendition ? `?rendition=${rendition}` : ""}`,
    ),
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
  schedule: (scheduleId: string) =>
    fetchJson<{ data: ScheduleSummary }>(`/api/v1/schedules/${scheduleId}`),
  schedules: (filters: ScheduleFilters & { limit?: number; offset?: number } = {}) =>
    fetchJson<PaginatedResponse<ScheduleSummary>>(withQuery("/api/v1/schedules", filters)),
  scheduleCalendar: (params: ScheduleFilters & { end?: string; start?: string } = {}) =>
    fetchJson<ScheduleCalendarResponse>(withQuery("/api/v1/schedules/calendar", params)),
  moveScheduleOccurrence: (
    scheduleId: string,
    input: { newStartAt: string; occurrenceStartAt: string },
  ) =>
    fetchJson<{ data: ScheduleSummary; source?: ScheduleSummary }>(
      `/api/v1/schedules/${scheduleId}/move-occurrence`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    ),
  startPlayback: (recordingId: string) =>
    fetchJson<{ data: RecordingPlaybackSession }>(`/api/v1/recordings/${recordingId}/playback`, {
      method: "POST",
    }),
  startListen: (nodeId: string, enhance = false) =>
    fetchJson<{ data: ListenMonitorSession }>(`/api/v1/nodes/${nodeId}/listen`, {
      body: JSON.stringify({ enhance }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  listenStream: (streamUrl: string) => fetchBlob(streamUrl),
  stopListen: (session: ListenMonitorSession) =>
    fetchJson<{ data: ListenMonitorStoppedSession }>(session.stopUrl, {
      method: "DELETE",
    }),
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
  assignChannelRooms: (
    nodeId: string,
    assignments: Array<{ channelIndexes: number[]; interfaceId: string; roomId: string | null }>,
  ) =>
    fetchJson<{ data: RecorderNode }>(`/api/v1/nodes/${nodeId}/channel-rooms`, {
      body: JSON.stringify({ assignments }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PUT",
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
