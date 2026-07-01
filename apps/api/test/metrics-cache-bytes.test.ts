import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordingSummary } from "@rakkr/shared";

const cacheRoot = await mkdtemp(path.join(tmpdir(), "rakkr-metrics-cache-bytes-"));
process.env.DATABASE_URL = "";
process.env.RAKKR_RECORDING_CACHE_DIR = path.join(cacheRoot, "cache");
process.env.RAKKR_RECORDING_CHUNK_STORE_PATH = path.join(cacheRoot, "chunks.json");

const { recordingCacheByteMap } = await import("../src/metrics-routes.js");
const { recordingChunkId, upsertRecordingChunk } = await import("../src/recording-chunks.js");

test.after(async () => {
  await rm(cacheRoot, { force: true, recursive: true });
});

test("G50b: recording cache bytes include chunked-recording chunk files", async () => {
  const chunked: RecordingSummary = {
    // Chunked recordings carry no recording-level cachePath.
    cached: true,
    durationSeconds: 120,
    folder: "Meetings",
    healthStatus: "healthy",
    id: "rec_metrics_chunked",
    name: "Chunked",
    recordedAt: "2026-06-18T12:00:00.000Z",
    source: "schedule",
    status: "cached",
    tags: [],
  };

  const chunkContents = "chunk-bytes-metric";
  const relativePath = `scheduled/${chunked.id}/part0001.mp3`;
  const absolute = path.join(cacheRoot, "cache", relativePath);

  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, chunkContents);
  await upsertRecordingChunk({
    cachePath: relativePath,
    createdAt: "2026-06-18T12:00:00.000Z",
    durationSeconds: 60,
    id: recordingChunkId(chunked.id, 1),
    index: 1,
    jobId: "job_metrics_chunked",
    offsetSeconds: 0,
    recordingId: chunked.id,
    status: "cached",
    total: 1,
  });

  const bytes = await recordingCacheByteMap([chunked]);

  // Pre-fix chunked recordings reported 0 bytes (no recording-level cachePath),
  // silently under-reporting controller-cache disk usage in /metrics.
  assert.equal(bytes[chunked.id], Buffer.byteLength(chunkContents));
});
