import assert from "node:assert/strict";
import test from "node:test";
import type { RecorderNode } from "@rakkr/shared";

import {
  recordingStartNodeLabel,
  startInputFromDraft,
  tagsFromText,
} from "./recording-start-helpers";

test("recording start input trims optional metadata and deduplicates tags", () => {
  assert.deepEqual(
    startInputFromDraft({
      folder: " meetings/voice ",
      name: " Council Room ",
      nodeId: "node_room_101",
      recordingProfileId: " profile_voice ",
      tags: "Voice, ad-hoc, voice, council",
      uploadPolicyId: " upload_stub ",
    }),
    {
      folder: "meetings/voice",
      name: "Council Room",
      nodeId: "node_room_101",
      recordingProfileId: "profile_voice",
      tags: ["Voice", "ad-hoc", "council"],
      uploadPolicyId: "upload_stub",
    },
  );
});

test("recording start input omits blank optional metadata", () => {
  assert.deepEqual(
    startInputFromDraft({
      folder: " ",
      name: "",
      nodeId: "node_room_101",
      recordingProfileId: " ",
      tags: "",
      uploadPolicyId: " ",
    }),
    {
      folder: undefined,
      name: undefined,
      nodeId: "node_room_101",
      recordingProfileId: undefined,
      tags: [],
      uploadPolicyId: undefined,
    },
  );
});

test("recording start tags preserve first spelling while matching case-insensitively", () => {
  assert.deepEqual(tagsFromText("Voice, voice, VOICE, Meeting"), ["Voice", "Meeting"]);
});

test("recording start node label includes room status and primary ip", () => {
  assert.equal(
    recordingStartNodeLabel(node()),
    "Council Rack (Main Campus / City Hall / 2 / Chamber · recording · 172.22.145.152)",
  );
});

function node(input: Partial<RecorderNode> = {}): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Council Rack",
    hostname: "rakkr-room-101",
    id: "node_room_101",
    interfaces: [],
    ipAddresses: ["172.22.145.152"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      building: "City Hall",
      floor: "2",
      room: "Chamber",
      site: "Main Campus",
    },
    status: "recording",
    tags: ["voice"],
    ...input,
  };
}
