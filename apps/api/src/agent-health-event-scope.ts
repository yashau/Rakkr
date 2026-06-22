import type { AuditTarget } from "./http-types.js";
import type { NodeCredentialAuth } from "./node-store.js";
import type { RecordingStore } from "./recording-store.js";
import type { ScheduleStore } from "./schedule-store.js";

interface NodeHealthEventScopeInput {
  recordingId?: string;
  scheduleId?: string;
}

interface NodeHealthEventScopeDependencies {
  credential: NodeCredentialAuth;
  recordingStore: RecordingStore;
  scheduleStore?: ScheduleStore;
}

export interface NodeHealthEventScopeFailure {
  error: string;
  reason: string;
  status: 403 | 404;
  target: AuditTarget;
}

export async function nodeHealthEventScopeFailure(
  input: NodeHealthEventScopeInput,
  dependencies: NodeHealthEventScopeDependencies,
): Promise<NodeHealthEventScopeFailure | undefined> {
  if (input.recordingId) {
    const failure = await recordingScopeFailure(input.recordingId, dependencies);

    if (failure) {
      return failure;
    }
  }

  if (input.scheduleId && dependencies.scheduleStore) {
    return scheduleScopeFailure(input.scheduleId, dependencies);
  }

  return undefined;
}

async function recordingScopeFailure(
  recordingId: string,
  { credential, recordingStore }: NodeHealthEventScopeDependencies,
): Promise<NodeHealthEventScopeFailure | undefined> {
  const recording = await recordingStore.find(recordingId);
  const target = { id: recordingId, type: "recording" } satisfies AuditTarget;

  if (!recording) {
    return { error: "Recording not found", reason: "recording_not_found", status: 404, target };
  }

  return recording.nodeId === credential.nodeId
    ? undefined
    : {
        error: "Node credential cannot access this recording",
        reason: "node_scope_denied",
        status: 403,
        target,
      };
}

async function scheduleScopeFailure(
  scheduleId: string,
  { credential, scheduleStore }: NodeHealthEventScopeDependencies,
): Promise<NodeHealthEventScopeFailure | undefined> {
  const schedule = await scheduleStore?.find(scheduleId);
  const target = { id: scheduleId, type: "schedule" } satisfies AuditTarget;

  if (!schedule) {
    return { error: "Schedule not found", reason: "schedule_not_found", status: 404, target };
  }

  return schedule.nodeId === credential.nodeId
    ? undefined
    : {
        error: "Node credential cannot access this schedule",
        reason: "node_scope_denied",
        status: 403,
        target,
      };
}
