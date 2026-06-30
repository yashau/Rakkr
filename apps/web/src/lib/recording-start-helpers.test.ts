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
      captureBackend: "jack",
      captureChannels: [],
      captureInterfaceId: " iface_jack ",
      channelMode: "",
      folder: " meetings/voice ",
      name: " Council Room ",
      nodeId: "node_room_101",
      recordingProfileId: " profile_voice ",
      tags: "Voice, ad-hoc, voice, council",
      uploadPolicyId: " upload_stub ",
    }),
    {
      captureBackend: "jack",
      captureChannelSelection: undefined,
      captureInterfaceId: "iface_jack",
      channelMode: undefined,
      folder: "meetings/voice",
      name: "Council Room",
      nodeId: "node_room_101",
      recordingProfileId: "profile_voice",
      tags: ["Voice", "ad-hoc", "council"],
      uploadPolicyId: "upload_stub",
    },
  );
});

test("recording start input pins a sorted channel selection and mode for an interface", () => {
  assert.deepEqual(
    startInputFromDraft({
      captureBackend: "",
      captureChannels: [4, 3],
      captureInterfaceId: "iface_x32",
      channelMode: "stereo",
      folder: "",
      name: "",
      nodeId: "node_room_101",
      recordingProfileId: "profile_voice",
      tags: "",
      uploadPolicyId: "",
    }),
    {
      captureBackend: undefined,
      captureChannelSelection: [3, 4],
      captureInterfaceId: "iface_x32",
      channelMode: "stereo",
      folder: undefined,
      name: undefined,
      nodeId: "node_room_101",
      recordingProfileId: "profile_voice",
      tags: [],
      uploadPolicyId: undefined,
    },
  );
});

test("recording start input drops channel selection without a pinned interface", () => {
  const input = startInputFromDraft({
    captureBackend: "",
    captureChannels: [1, 2],
    captureInterfaceId: "",
    channelMode: "stereo",
    folder: "",
    name: "",
    nodeId: "node_room_101",
    recordingProfileId: "profile_voice",
    tags: "",
    uploadPolicyId: "",
  });

  assert.equal(input.captureChannelSelection, undefined);
  assert.equal(input.channelMode, undefined);
});

test("recording start input omits blank optional metadata", () => {
  assert.deepEqual(
    startInputFromDraft({
      captureBackend: "",
      captureChannels: [],
      captureInterfaceId: " ",
      channelMode: "",
      folder: " ",
      name: "",
      nodeId: "node_room_101",
      recordingProfileId: " ",
      tags: "",
      uploadPolicyId: " ",
    }),
    {
      captureBackend: undefined,
      captureChannelSelection: undefined,
      captureInterfaceId: undefined,
      channelMode: undefined,
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
