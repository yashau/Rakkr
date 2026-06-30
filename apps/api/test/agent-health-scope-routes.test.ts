import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type {
  AuditEvent,
  MeterFrame,
  RecorderNode,
  RecordingSummary,
  ScheduleSummary,
} from "@rakkr/shared";
import type { AppBindings, RecordAuditEvent } from "../src/http-types.js";
import type { MeterFrameStore } from "../src/meter-store.js";
import type { NodeHeartbeatInput, NodeStore } from "../src/node-store.js";
import type { RecordingStore } from "../src/recording-store.js";
import type { ScheduleStore } from "../src/schedule-store.js";
import type { SettingsStore } from "../src/settings-store.js";

const { createAuditStore } = await import("../src/audit-store.js");
const { registerAgentRoutes } = await import("../src/agent-routes.js");
const { createHealthEventStore } = await import("../src/health-store.js");

test("agent health sync validates schedule ownership", async () => {
  const app = new Hono<AppBindings>();
  const auditStore = createAuditStore("");
  const healthEventStore = createHealthEventStore("", []);
  const visibleSchedule = schedule({ id: "sched_agent_visible", nodeId: node().id });
  const hiddenSchedule = schedule({ id: "sched_agent_hidden", nodeId: "node_agent_other" });

  registerAgentRoutes({
    app,
    healthEventStore,
    meterFrameStore: memoryMeterFrameStore(),
    nodeStore: memoryNodeStore(),
    recordAuditEvent: recordAuditEvent(auditStore),
    recordingStore: memoryRecordingStore(),
    scheduleStore: memoryScheduleStore([visibleSchedule, hiddenSchedule]),
    settingsStore: {} as SettingsStore,
  });

  const visibleResponse = await healthSync(app, visibleSchedule.id, "agent.capture.warning");
  const hiddenResponse = await healthSync(app, hiddenSchedule.id, "agent.capture.hidden_schedule");
  const events = await healthEventStore.list({});
  const [failedAudit] = await auditStore.list({ action: "nodes.health_events.sync.failed" });

  assert.equal(visibleResponse.status, 201);
  assert.equal(hiddenResponse.status, 403);
  assert.deepEqual(
    events.map((event) => event.scheduleId),
    [visibleSchedule.id],
  );
  assert.equal(failedAudit?.reason, "node_scope_denied");
  assert.equal(failedAudit?.target.id, hiddenSchedule.id);
  assert.equal(failedAudit?.target.type, "schedule");
});

function healthSync(app: Hono<AppBindings>, scheduleId: string, type: string) {
  return app.request(`/api/v1/nodes/${node().id}/health-events`, {
    body: JSON.stringify({
      id: `local-${scheduleId}`,
      scheduleId,
      severity: "warning",
      type,
    }),
    headers: {
      authorization: "Bearer node-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function memoryNodeStore(nodes: RecorderNode[] = [node()]): NodeStore {
  return {
    async authenticateCredential(token) {
      return token === "node-token"
        ? {
            credentialId: "cred_agent_health_scope",
            nodeId: nodes[0]?.id ?? "node_agent_test",
            tokenPrefix: "node-token",
          }
        : undefined;
    },
    async enroll() {
      throw new Error("not implemented");
    },
    async find(nodeId) {
      return nodes.find((candidate) => candidate.id === nodeId);
    },
    async heartbeat(nodeId: string, input: NodeHeartbeatInput) {
      return nodes.find((candidate) => candidate.id === nodeId)
        ? { ...node(), runtime: input.runtime, status: input.status }
        : undefined;
    },
    async list() {
      return nodes;
    },
    async rotateCredential() {
      throw new Error("not implemented");
    },
    async updateInterface() {
      throw new Error("not implemented");
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

function memoryMeterFrameStore(): MeterFrameStore {
  const frames: MeterFrame[] = [];

  return {
    async history() {
      return frames;
    },
    async latest() {
      return frames[0];
    },
    async save(frame) {
      frames.unshift(frame);

      return { frame, receivedAt: new Date().toISOString() };
    },
  };
}

function memoryRecordingStore(recordings: RecordingSummary[] = []): RecordingStore {
  return {
    async create(recording) {
      recordings.unshift(recording);
    },
    async delete(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async find(recordingId) {
      return recordings.find((candidate) => candidate.id === recordingId);
    },
    async list() {
      return recordings;
    },
    async save(recording) {
      recordings.unshift(recording);
    },
  };
}

function memoryScheduleStore(schedules: ScheduleSummary[]): ScheduleStore {
  return {
    async create() {
      throw new Error("not implemented");
    },
    async delete() {
      throw new Error("not implemented");
    },
    async find(scheduleId) {
      return schedules.find((candidate) => candidate.id === scheduleId);
    },
    async list() {
      return schedules;
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

function recordAuditEvent(auditStore: ReturnType<typeof createAuditStore>): RecordAuditEvent {
  return async (_c, input) => {
    const event: AuditEvent = {
      action: input.action,
      actor: input.actor ?? { id: "node_agent_test", name: "Node Agent", roles: [], type: "node" },
      actorContext: {},
      after: input.after,
      before: input.before,
      correlationIds: input.correlationIds,
      createdAt: new Date().toISOString(),
      details: input.details ?? {},
      id: `audit_${randomUUID()}`,
      outcome: input.outcome,
      permission: input.permission,
      reason: input.reason,
      target: input.target,
    };

    await auditStore.append(event);

    return event;
  };
}

function node(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Agent Health Scope Node",
    hostname: "agent-health-scope-node",
    id: "node_agent_test",
    interfaces: [],
    ipAddresses: ["127.0.0.1"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: { room: "Test Room", site: "Test Site" },
    status: "online",
    tags: [],
  };
}

function schedule(input: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    enabled: true,
    folderTemplate: "agent/{{date}}",
    id: "sched_agent_test",
    name: "Agent Schedule",
    nextRunAt: "2026-06-18T12:30:00.000Z",
    nodeId: node().id,
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    room: "Test Room",
    tags: ["agent"],
    timezone: "UTC",
    titleTemplate: "{{date}} Agent Schedule",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
    ...input,
  };
}
