import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

import {
  clearPlaybackPreview,
  isCachedRecording,
  isTerminalRecording,
  playbackPreviewFromSession,
  recordingFileActionState,
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

function playbackPreview(objectUrl: string): RecordingPlaybackPreview {
  return {
    fileName: "council-voice.mp3",
    objectUrl,
    recordingId: "rec_web_action_test",
    sessionId: "playback_test",
    startedAt: "2026-06-18T12:00:00.000Z",
  };
}
