import type { AuditTarget } from "./http-types.js";
import type { NodeCredentialAuth } from "./node-store.js";
import type { RecordingStore } from "./recording-store.js";

interface AgentJobRecordingScopeInput {
  recordingId: string;
}

interface AgentJobRecordingScopeDependencies {
  credential: NodeCredentialAuth;
  recordingStore: RecordingStore;
}

export async function agentJobRecordingScope(
  input: AgentJobRecordingScopeInput,
  { credential, recordingStore }: AgentJobRecordingScopeDependencies,
) {
  const recording = await recordingStore.find(input.recordingId);
  const target = { id: input.recordingId, type: "recording" } satisfies AuditTarget;

  if (!recording) {
    return {
      error: "Recording not found",
      ok: false,
      reason: "recording_not_found",
      status: 404,
      target,
    } as const;
  }

  if (recording.nodeId !== credential.nodeId) {
    return {
      error: "Node credential cannot access this recording",
      ok: false,
      reason: "node_scope_denied",
      status: 403,
      target: { ...target, name: recording.name },
    } as const;
  }

  return { ok: true, recording } as const;
}
