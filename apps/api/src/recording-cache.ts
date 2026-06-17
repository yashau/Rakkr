import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecordingSummary } from "@rakkr/shared";

export interface CachedRecordingFile {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  size: number;
}

const cacheRoot = path.resolve(process.env.RAKKR_RECORDING_CACHE_DIR ?? "data/recordings");

export function recordingHasCachedFile(recording: RecordingSummary) {
  return (
    Boolean(recording.cachePath) &&
    (recording.cached || recording.status === "cached" || recording.status === "uploaded")
  );
}

export async function loadRecordingFile(recording: RecordingSummary): Promise<CachedRecordingFile> {
  const filePath = resolvedCachePath(recording);

  await materializePlaceholderFile(recording, filePath);

  const bytes = await readFile(filePath);

  return {
    bytes,
    fileName: recordingFileName(recording),
    mimeType: mimeTypeFor(filePath),
    size: bytes.byteLength,
  };
}

export function recordingFileName(recording: RecordingSummary) {
  const cleanedName = recording.name.replace(/[^\w .-]/g, "_").trim();
  const extension = path.extname(recording.cachePath ?? "") || ".mp3";

  return `${cleanedName || recording.id}${extension}`;
}

function resolvedCachePath(recording: RecordingSummary) {
  if (!recordingHasCachedFile(recording) || !recording.cachePath) {
    throw new Error("recording_not_cached");
  }

  const resolved = path.resolve(cacheRoot, recording.cachePath);
  const relative = path.relative(cacheRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("recording_cache_path_outside_root");
  }

  return resolved;
}

async function materializePlaceholderFile(recording: RecordingSummary, filePath: string) {
  try {
    await stat(filePath);
    return;
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, placeholderBytes(recording));
  }
}

function placeholderBytes(recording: RecordingSummary) {
  return Buffer.from(
    [
      "RAKKR placeholder cached recording",
      `id=${recording.id}`,
      `name=${recording.name}`,
      `recordedAt=${recording.recordedAt}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function mimeTypeFor(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".flac") {
    return "audio/flac";
  }

  if (extension === ".wav") {
    return "audio/wav";
  }

  return "audio/mpeg";
}
