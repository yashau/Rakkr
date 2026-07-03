import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ScheduleSummary } from "@rakkr/shared";

// Exercises the Postgres room-delete RESTRICT FK path. Runs only when a test DB is
// provided via RAKKR_API_TEST_DATABASE_URL. DATABASE_URL must be set BEFORE
// importing the stores.
//
// In DB mode, run with `--test-force-exit` — the db client pool has no exposed
// close.
const dbUrl = process.env.RAKKR_API_TEST_DATABASE_URL;

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
}

const { createRoomStore, RoomStoreError } = await import("../src/room-store.js");
const { createScheduleStore } = await import("../src/schedule-store.js");

test(
  "room delete surfaces a RESTRICT FK race as RoomStoreError room_in_use, not a DB outage",
  {
    skip: dbUrl ? false : "requires RAKKR_API_TEST_DATABASE_URL (Postgres)",
  },
  async () => {
    const roomStore = createRoomStore();
    const scheduleStore = createScheduleStore();
    const roomId = `room_fkrace_${randomUUID()}`;

    await roomStore.create({ id: roomId, name: "FK Race Room", site: "HQ" });
    await scheduleStore.create(schedule(roomId));

    // Simulates the check->delete race: a schedule references the room, so the
    // DELETE trips schedules.roomId RESTRICT (SQLSTATE 23503). The store must throw
    // RoomStoreError room_in_use (-> route 409), not DatabaseUnavailableError (503).
    await assert.rejects(
      () => roomStore.delete(roomId),
      (error: unknown) => error instanceof RoomStoreError && error.code === "room_in_use",
    );
  },
);

function schedule(roomId: string): ScheduleSummary {
  return {
    assignedGroupIds: [],
    assignedUserIds: [],
    captureChannelSelection: [1],
    captureInterfaceId: "iface-1",
    channelMode: "mono",
    enabled: true,
    folderTemplate: "meetings/{{date}}",
    id: `sched_${randomUUID()}`,
    name: "FK Race Schedule",
    nextRunAt: "2026-06-18T09:00:00.000Z",
    nodeId: `node_${randomUUID()}`,
    recurrence: { mode: "manual" },
    recordingProfileId: "voice-mp3-vbr",
    retentionPolicyId: "retention-keep-controller-cache",
    roomId,
    tags: [],
    timezone: "UTC",
    titleTemplate: "{{date}} FK Race",
    uploadPolicyIds: ["upload-policy-stub"],
    watchdogPolicyId: "scheduled-voice-watchdog",
  };
}
