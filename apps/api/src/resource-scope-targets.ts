// Resource-scope target expansion: turns a request target into the full set of
// (resource + room) targets it authorizes against. Extracted from index.ts to
// keep that module within the LOC budget. Room resolution is per-channel — a
// recording/schedule resolves to its own persisted room and a node to the union
// of its channels' rooms (see scope-targets.ts / room-resolution.ts).

import type { RecorderNode } from "@rakkr/shared";

import type { HealthEventStore } from "./health-store.js";
import type { AuditTarget } from "./http-types.js";
import type { NodeStore } from "./node-store.js";
import { recordingJob } from "./recording-jobs.js";
import type { RecordingStore } from "./recording-store.js";
import {
  addChannelScopeTargets,
  addInterfaceScopeTargets,
  addNodeResourceTargets,
  addNodeScopeTargets,
} from "./scope-targets.js";
import type { ScheduleStore } from "./schedule-store.js";

type NodeRecord = RecorderNode;

interface ResourceScopeTargetsDeps {
  healthEventStore: HealthEventStore;
  nodeStore: NodeStore;
  recordingStore: RecordingStore;
  scheduleStore: ScheduleStore;
}

export function createResourceScopeTargets({
  healthEventStore,
  nodeStore,
  recordingStore,
  scheduleStore,
}: ResourceScopeTargetsDeps) {
  async function resourceScopeTargets(target: AuditTarget): Promise<AuditTarget[]> {
    const targets = [target];
    const knownNodes = await nodeStore.list();

    if (target.type === "recording" && target.id) {
      await addRecordingScopeTargets(targets, target.id, knownNodes);
    }

    if (target.type === "recording_job" && target.id) {
      const job = await recordingJob(target.id);

      if (job) {
        await addRecordingScopeTargets(targets, job.recordingId, knownNodes);

        // Node resource (no room union) so a node grant still authorizes the job,
        // but the room stays the recording's single room resolved above.
        const node = knownNodes.find((candidate) => candidate.id === job.nodeId);

        if (node) {
          addNodeResourceTargets(targets, node);
        }
      }
    }

    if (target.type === "schedule" && target.id) {
      await addScheduleScopeTargets(targets, target.id, knownNodes);
    }

    if (target.type === "node" && target.id) {
      addNodeScopeTargets(targets, target.id, knownNodes);
    }

    if (target.type === "health_event" && target.id) {
      const event = await healthEventStore.find(target.id);

      // A recording-scoped health event follows its recording's single room, and a
      // schedule-scoped one follows its schedule's single room (both strict on a
      // shared node). Only a genuinely node-level event — no recording AND no
      // schedule (e.g. an offline/xrun alert) — takes the node's room UNION, so
      // both rooms sharing a node see it. A schedule-scoped event must NOT take the
      // union or it leaks the other room's schedule health across a shared node.
      if (event?.recordingId) {
        await addRecordingScopeTargets(targets, event.recordingId, knownNodes);
      } else if (event?.nodeId && !event.scheduleId) {
        addNodeScopeTargets(targets, event.nodeId, knownNodes);
      }

      if (event?.scheduleId) {
        await addScheduleScopeTargets(targets, event.scheduleId, knownNodes);
      }
    }

    if (target.type === "interface" && target.id) {
      addInterfaceScopeTargets(targets, target.id, knownNodes);
    }

    if (target.type === "channel" && target.id) {
      addChannelScopeTargets(targets, target.id, knownNodes);
    }

    return targets.filter(
      (candidate, index, allTargets) =>
        candidate.id &&
        allTargets.findIndex(
          (other) => other.type === candidate.type && other.id === candidate.id,
        ) === index,
    );
  }

  async function addRecordingScopeTargets(
    targets: AuditTarget[],
    recordingId: string,
    knownNodes: NodeRecord[],
  ) {
    const recording = await recordingStore.find(recordingId);

    if (!recording) {
      return;
    }

    targets.push({ id: recording.id, type: "recording" });

    // The recording's own persisted room is the single room it resolves to — never
    // the node's room union — so a shared node cannot leak one room's recordings.
    if (recording.roomId) {
      targets.push({ id: recording.roomId, type: "room" });
    }

    if (recording.scheduleId) {
      await addScheduleScopeTargets(targets, recording.scheduleId, knownNodes);
    }

    if (recording.nodeId) {
      const node = knownNodes.find((candidate) => candidate.id === recording.nodeId);

      if (node) {
        addNodeResourceTargets(targets, node);
      }
    }
  }

  async function addScheduleScopeTargets(
    targets: AuditTarget[],
    scheduleId: string,
    knownNodes: NodeRecord[],
  ) {
    const schedule = await scheduleStore.find(scheduleId);

    if (!schedule) {
      return;
    }

    targets.push({ id: schedule.id, type: "schedule" });

    // A schedule resolves to its own single room; node resource (no room union).
    if (schedule.roomId) {
      targets.push({ id: schedule.roomId, type: "room" });
    }

    const node = knownNodes.find((candidate) => candidate.id === schedule.nodeId);

    if (node) {
      addNodeResourceTargets(targets, node);
    }
  }

  return resourceScopeTargets;
}
