import assert from "node:assert/strict";
import test from "node:test";
import type {
  CurrentUser,
  Permission,
  RecorderNode,
  RecordingProfile,
  RecordingSummary,
  ScheduleSummary,
  UploadPolicy,
} from "@rakkr/shared";

import {
  clearPlaybackPreview,
  emptyRecordingFilterDraft,
  filtersFromDraft,
  isCachedRecording,
  isTerminalRecording,
  playbackPreviewFromSession,
  recordingFilterChips,
  recordingFileActionState,
  recordingPagePermissions,
  recordingRelationshipBadges,
  uploadQueueStatusSummary,
  replacePlaybackPreview,
  type RecordingPlaybackPreview,
  waveformBarHeightPercent,
  waveformPreviewSummary,
} from "./recording-page-helpers";

test("recording action helpers identify cached files for playback download and upload", () => {
  assert.equal(isCachedRecording(recording({ cached: true, cachePath: "ad-hoc/rec.mp3" })), true);
  assert.equal(
    isCachedRecording(recording({ cachePath: "ad-hoc/rec.mp3", status: "cached" })),
    true,
  );
  assert.equal(
    isCachedRecording(recording({ cachePath: "ad-hoc/rec.mp3", status: "uploaded" })),
    true,
  );
  assert.equal(isCachedRecording(recording({ cached: true, cachePath: undefined })), false);
  assert.equal(
    isCachedRecording(recording({ cachePath: "ad-hoc/rec.mp3", status: "recording" })),
    false,
  );
});

test("recording action helpers keep destructive actions off active recordings", () => {
  assert.equal(isTerminalRecording(recording({ status: "queued" })), false);
  assert.equal(isTerminalRecording(recording({ status: "recording" })), false);
  assert.equal(isTerminalRecording(recording({ status: "failed" })), true);
  assert.equal(isTerminalRecording(recording({ status: "cached" })), true);
  assert.equal(isTerminalRecording(recording({ status: "uploaded" })), true);
});

test("recording playback preview tracks session and file details", () => {
  const preview = playbackPreviewFromSession(
    {
      mode: "controller_cache",
      recordingId: "rec_web_action_test",
      sessionId: "playback_test",
      startedAt: "2026-06-18T12:00:00.000Z",
      streamUrl: "/api/v1/recordings/rec_web_action_test/stream",
    },
    {
      blob: new Blob(["audio"]),
      fileName: "council-voice.mp3",
    },
    "blob:preview-new",
  );

  assert.deepEqual(preview, {
    fileName: "council-voice.mp3",
    objectUrl: "blob:preview-new",
    recordingId: "rec_web_action_test",
    sessionId: "playback_test",
    startedAt: "2026-06-18T12:00:00.000Z",
  });
});

test("recording playback preview replacement revokes stale object URLs", () => {
  const revoked: string[] = [];
  const current = playbackPreview("blob:preview-old");
  const next = playbackPreview("blob:preview-new");

  assert.equal(
    replacePlaybackPreview(current, next, (url) => revoked.push(url)),
    next,
  );
  assert.deepEqual(revoked, ["blob:preview-old"]);
});

test("recording playback preview cleanup can clear the active object URL", () => {
  const revoked: string[] = [];

  assert.equal(
    clearPlaybackPreview(playbackPreview("blob:preview-active"), (url) => revoked.push(url)),
    undefined,
  );
  assert.deepEqual(revoked, ["blob:preview-active"]);
});

test("recording file action state requires both permission and cached media", () => {
  assert.deepEqual(
    recordingFileActionState(recording({ cached: true, cachePath: "scheduled/track.mp3" }), {
      canDownload: true,
      canPlayback: true,
    }),
    {
      canDownload: true,
      canPlayback: true,
      fileReady: true,
    },
  );
  assert.deepEqual(
    recordingFileActionState(recording({ cached: true, cachePath: "scheduled/track.mp3" }), {
      canDownload: false,
      canPlayback: true,
    }),
    {
      canDownload: false,
      canPlayback: true,
      fileReady: true,
    },
  );
  assert.deepEqual(
    recordingFileActionState(recording({ cachePath: undefined, status: "completed" }), {
      canDownload: true,
      canPlayback: true,
    }),
    {
      canDownload: false,
      canPlayback: false,
      fileReady: false,
    },
  );
});

test("recording cache state filters round trip through API filters and chips", () => {
  const filters = filtersFromDraft({ ...emptyRecordingFilterDraft, cacheState: "missing" });

  assert.equal(filters.cacheState, "missing");
  assert.deepEqual(recordingFilterChips(filters), [
    { key: "cacheState", label: "cache", value: "missing" },
  ]);
});

test("upload queue status summary counts visible recording items in operator order", () => {
  const items = [
    uploadQueueItem({ id: "upload_queued", recordingId: "rec_visible_a", status: "queued" }),
    uploadQueueItem({ id: "upload_failed", recordingId: "rec_visible_b", status: "failed" }),
    uploadQueueItem({ id: "upload_retrying", recordingId: "rec_visible_b", status: "retrying" }),
    uploadQueueItem({ id: "upload_hidden", recordingId: "rec_hidden", status: "failed" }),
  ];

  assert.deepEqual(uploadQueueStatusSummary(items, ["rec_visible_a", "rec_visible_b"]), [
    { count: 1, status: "failed" },
    { count: 1, status: "retrying" },
    { count: 1, status: "queued" },
  ]);
});

test("recording page permissions are closed by default", () => {
  assert.deepEqual(recordingPagePermissions(undefined), {
    canControlRecordings: false,
    canCreateRecordings: false,
    canDeleteRecordings: false,
    canDownloadRecordings: false,
    canEditRecordings: false,
    canPlaybackRecordings: false,
    canReadHealth: false,
    canReadNodes: false,
    canReadRecordings: false,
    canReadSchedules: false,
    canReadSettings: false,
  });
});

test("recording read permission does not imply related health or settings reads", () => {
  assert.deepEqual(recordingPagePermissions(user(["recording:read"])), {
    canControlRecordings: false,
    canCreateRecordings: false,
    canDeleteRecordings: false,
    canDownloadRecordings: false,
    canEditRecordings: false,
    canPlaybackRecordings: false,
    canReadHealth: false,
    canReadNodes: false,
    canReadRecordings: true,
    canReadSchedules: false,
    canReadSettings: false,
  });
});

test("recording page permissions mirror granular read and action grants", () => {
  assert.deepEqual(
    recordingPagePermissions(
      user([
        "health:read",
        "node:read",
        "recording:control",
        "recording:create",
        "recording:delete",
        "recording:download",
        "recording:edit",
        "recording:playback",
        "recording:read",
        "schedule:read",
        "settings:read",
      ]),
    ),
    {
      canControlRecordings: true,
      canCreateRecordings: true,
      canDeleteRecordings: true,
      canDownloadRecordings: true,
      canEditRecordings: true,
      canPlaybackRecordings: true,
      canReadHealth: true,
      canReadNodes: true,
      canReadRecordings: true,
      canReadSchedules: true,
      canReadSettings: true,
    },
  );
});

test("recording relationship badges prefer permitted friendly reference names", () => {
  assert.deepEqual(
    recordingRelationshipBadges(
      recording({
        nodeId: "node_web_action_test",
        recordingProfileId: "profile_voice",
        scheduleId: "sched_council",
        trackGroupId: "track_group_1",
        trackIndex: 2,
        trackTotal: 4,
        uploadPolicyId: "upload_stub",
      }),
      {
        nodes: [recorderNode()],
        recordingProfiles: [recordingProfile()],
        schedules: [schedule()],
        uploadPolicies: [uploadPolicy()],
      },
    ),
    [
      { label: "node", value: "Council Rack (Council Chamber / 10.0.0.10)" },
      { label: "schedule", value: "Weekly Council" },
      { label: "profile", value: "Voice MP3" },
      { label: "upload", value: "Stub Upload" },
      { label: "track", value: "2/4" },
      { label: "group", value: "track_group_1" },
    ],
  );
});

test("recording relationship badges fall back to ids without reference access", () => {
  assert.deepEqual(
    recordingRelationshipBadges(
      recording({
        nodeId: "node_web_action_test",
        recordingProfileId: "profile_voice",
        scheduleId: "sched_council",
        uploadPolicyId: "upload_stub",
      }),
    ),
    [
      { label: "node", value: "node_web_action_test" },
      { label: "schedule", value: "sched_council" },
      { label: "profile", value: "profile_voice" },
      { label: "upload", value: "upload_stub" },
    ],
  );
});

test("recording waveform helper clamps peak heights for stable previews", () => {
  assert.equal(waveformBarHeightPercent(-0.5), "10%");
  assert.equal(waveformBarHeightPercent(0), "10%");
  assert.equal(waveformBarHeightPercent(0.42), "42%");
  assert.equal(waveformBarHeightPercent(1.5), "100%");
});

test("recording waveform summary exposes preview metadata", () => {
  assert.equal(
    waveformPreviewSummary({
      channelCount: 2,
      generatedAt: "2026-06-18T12:00:00.000Z",
      peaks: [0.1, 0.5, 1],
      sampleCount: 96000,
      sampleRate: 48000,
      source: "ffmpeg_decoded_peak",
    }),
    "3 peaks · 2 ch · 48000 Hz · decoded",
  );
});

function recording(input: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 60,
    folder: "meetings/2026-06-18",
    healthStatus: "healthy",
    id: "rec_web_action_test",
    name: "Council Voice",
    nodeId: "node_web_action_test",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "ad_hoc",
    status: "completed",
    tags: ["voice"],
    ...input,
  };
}

function recorderNode(): RecorderNode {
  return {
    agentVersion: "0.1.0",
    alias: "Council Rack",
    hostname: "council-rack",
    id: "node_web_action_test",
    interfaces: [],
    ipAddresses: ["10.0.0.10"],
    lastSeenAt: "2026-06-18T12:00:00.000Z",
    location: {
      room: "Council Chamber",
      site: "City Hall",
    },
    status: "online",
    tags: ["voice"],
  };
}

function playbackPreview(objectUrl: string): RecordingPlaybackPreview {
  return {
    fileName: "council-voice.mp3",
    objectUrl,
    recordingId: "rec_web_action_test",
    sessionId: "playback_test",
    startedAt: "2026-06-18T12:00:00.000Z",
  };
}

function recordingProfile(): RecordingProfile {
  return {
    bitrateKbps: 128,
    channelMode: "mono_to_stereo_mix",
    codec: "mp3",
    id: "profile_voice",
    name: "Voice MP3",
    silenceDetectionEnabled: false,
    silenceSkipEnabled: false,
    vbr: true,
  };
}

function schedule(): ScheduleSummary {
  return {
    enabled: true,
    folderTemplate: "Meetings/{{date}}",
    id: "sched_council",
    name: "Weekly Council",
    nodeId: "node_web_action_test",
    recurrence: { mode: "manual" },
    recordingProfileId: "profile_voice",
    room: "Council Chamber",
    tags: ["voice"],
    timezone: "Indian/Maldives",
    titleTemplate: "Council {{date}}",
    uploadPolicyId: "upload_stub",
    watchdogPolicyId: "watchdog_voice",
  };
}

function uploadPolicy(): UploadPolicy {
  return {
    deleteCacheAfterUpload: false,
    enabled: true,
    id: "upload_stub",
    maxAttempts: 5,
    name: "Stub Upload",
    provider: "stub",
    trigger: "manual",
    updatedAt: "2026-06-18T12:00:00.000Z",
  };
}

function uploadQueueItem(input: {
  id: string;
  recordingId: string;
  status: "cancelled" | "failed" | "queued" | "retrying" | "succeeded";
}) {
  return {
    attemptCount: 0,
    createdAt: "2026-06-18T12:00:00.000Z",
    id: input.id,
    maxAttempts: 5,
    nextAttemptAt: "2026-06-18T12:00:00.000Z",
    provider: "stub" as const,
    recordingId: input.recordingId,
    status: input.status,
    updatedAt: "2026-06-18T12:00:00.000Z",
  };
}

function user(permissions: Permission[]): CurrentUser {
  return {
    email: "operator@example.test",
    groups: [],
    id: "user_operator",
    name: "Operator",
    permissions,
    provider: "local",
    resourceGrants: [],
    roles: ["operator"],
  };
}
