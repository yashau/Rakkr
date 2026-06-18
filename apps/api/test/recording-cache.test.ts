import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const cacheRoot = await mkdtemp(path.join(tmpdir(), "rakkr-cache-"));
process.env.RAKKR_RECORDING_CACHE_DIR = cacheRoot;

const { storeRecordingFile } = await import("../src/recording-cache.js");
const fakeAudioToolPath = path.join(cacheRoot, "fake-audio-tool.mjs");

await writeFile(fakeAudioToolPath, fakeAudioToolScript());
process.env.RAKKR_FFMPEG_ARGS_PREFIX = JSON.stringify([fakeAudioToolPath, "ffmpeg"]);
process.env.RAKKR_FFMPEG_COMMAND = process.execPath;
process.env.RAKKR_FFPROBE_ARGS_PREFIX = JSON.stringify([fakeAudioToolPath, "ffprobe"]);
process.env.RAKKR_FFPROBE_COMMAND = process.execPath;

test.after(async () => {
  await rm(cacheRoot, { force: true, recursive: true });
});

test("stores checksum and wav waveform preview for cached recordings", async () => {
  const bytes = wavFile([0, 16_384, -32_768, 8192]);
  const stored = await storeRecordingFile(recording(), {
    bytes,
    fileName: "meeting.wav",
    mimeType: "audio/wav",
  });

  assert.equal(stored.cachePath, "scheduled/rec_cache_test.wav");
  assert.equal(stored.checksum, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  assert.equal(stored.waveformPreview?.channelCount, 1);
  assert.equal(stored.waveformPreview?.sampleCount, 4);
  assert.equal(stored.waveformPreview?.sampleRate, 48_000);
  assert.deepEqual(stored.waveformPreview?.peaks, [0, 0.5, 1, 0.25]);
});

test("extracts duration and decoded waveform preview for encoded recordings", async () => {
  const stored = await storeRecordingFile(recording(), {
    bytes: Buffer.from("fake mp3 payload"),
    fileName: "meeting.mp3",
    mimeType: "audio/mpeg",
  });

  assert.equal(stored.cachePath, "scheduled/rec_cache_test.mp3");
  assert.equal(stored.durationSeconds, 2);
  assert.equal(stored.waveformPreview?.source, "ffmpeg_decoded_peak");
  assert.equal(stored.waveformPreview?.sampleRate, 48_000);
  assert.deepEqual(stored.waveformPreview?.peaks, [0, 1]);
});

function recording(): RecordingSummary {
  return {
    cached: false,
    durationSeconds: 0,
    folder: "Meetings",
    healthStatus: "unknown",
    id: "rec_cache_test",
    name: "Cache Test",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "recording",
    tags: [],
  };
}

function wavFile(samples: number[]) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48_000, 24);
  buffer.writeUInt32LE(96_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));

  return buffer;
}

function fakeAudioToolScript() {
  const wavBase64 = wavFile([0, -32_768]).toString("base64");

  return `
const mode = process.argv[2];

if (mode === "ffprobe") {
  process.stdout.write(JSON.stringify({ format: { duration: "2.0" } }));
  process.exit(0);
}

if (mode === "ffmpeg") {
  process.stdout.write(Buffer.from("${wavBase64}", "base64"));
  process.exit(0);
}

process.exit(1);
`;
}
