import assert from "node:assert/strict";
import test from "node:test";
import type { HealthEvent, RecorderNode, ScheduleSummary } from "@rakkr/shared";
import type { AuditTarget } from "../src/http-types.js";

const { createResourceScopeTargets } = await import("../src/resource-scope-targets.js");

// Shared node: channels 1-2 -> room-a, channels 3-4 -> room-b.
function sharedNode(): RecorderNode {
  return {
    agentVersion: "2026.1.1-1",
    alias: "Shared Node",
    hostname: "shared-node",
    id: "node-shared",
    interfaces: [
      {
        alias: "X32",
        backend: "alsa",
        channelCount: 4,
        channels: [
          { alias: "Ch 1", index: 1, roomId: "room-a" },
          { alias: "Ch 2", index: 2, roomId: "room-a" },
          { alias: "Ch 3", index: 3, roomId: "room-b" },
          { alias: "Ch 4", index: 4, roomId: "room-b" },
        ],
        id: "iface-1",
        sampleRates: [48000],
        systemName: "X-USB",
        systemRef: "hw:CARD=X32",
      },
    ],
    ipAddresses: ["10.0.0.9"],
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    location: { room: "Install Rack", site: "HQ" },
    status: "online",
    tags: [],
  };
}

function targetsFor(event: Partial<HealthEvent>, schedule?: ScheduleSummary) {
  const resourceScopeTargets = createResourceScopeTargets({
    healthEventStore: {
      async find() {
        return event as HealthEvent;
      },
    } as never,
    nodeStore: {
      async list() {
        return [sharedNode()];
      },
    } as never,
    recordingStore: {
      async find() {
        return undefined;
      },
    } as never,
    scheduleStore: {
      async find() {
        return schedule;
      },
    } as never,
  });

  return resourceScopeTargets({ id: "he-1", type: "health_event" });
}

function roomIds(targets: AuditTarget[]): string[] {
  return [
    ...new Set(
      targets
        .filter((target) => target.type === "room" && target.id)
        .map((target) => target.id as string),
    ),
  ].sort();
}

function schedule(roomId: string): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id: "sched_b",
    name: "Room B Meeting",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: "node-shared",
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    roomId,
    tags: [],
    timezone: "UTC",
    titleTemplate: "{{date}} Room B Meeting",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
  };
}

test("a schedule-scoped health event resolves to only its schedule's room (no node union)", async () => {
  const targets = await targetsFor(
    {
      id: "he-1",
      nodeId: "node-shared",
      scheduleId: "sched_b",
      type: "schedule.capture_channels_busy",
    },
    schedule("room-b"),
  );

  // The event belongs to room-b's schedule; a shared node must NOT expand it to
  // the room-a/room-b union (which would leak it to a room-a-only operator).
  assert.deepEqual(roomIds(targets), ["room-b"]);
});

test("a genuinely node-level health event (no recording, no schedule) keeps the node room union", async () => {
  const targets = await targetsFor({
    id: "he-1",
    nodeId: "node-shared",
    type: "node.offline",
  });

  // An offline/xrun alert has no recording or schedule, so both rooms sharing the
  // node should see it.
  assert.deepEqual(roomIds(targets), ["room-a", "room-b"]);
});
