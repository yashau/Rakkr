import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecordingSummary } from "@rakkr/shared";

export interface CachedRecordingFile {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface StoredRecordingFile {
  cachePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface StoreRecordingFileInput {
  bytes: Buffer;
  fileName?: string | null;
  mimeType?: string | null;
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
  const bytes = await readCachedFile(filePath);

  return {
    bytes,
    fileName: recordingFileName(recording),
    mimeType: mimeTypeFor(filePath),
    size: bytes.byteLength,
  };
}

export async function storeRecordingFile(
  recording: RecordingSummary,
  input: StoreRecordingFileInput,
): Promise<StoredRecordingFile> {
  const cachePath = cachePathFor(recording, input);
  const filePath = resolvedCachePathFromRelative(cachePath);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, input.bytes);

  return {
    cachePath,
    fileName: recordingFileName({ ...recording, cachePath }),
    mimeType: mimeTypeFor(filePath),
    size: input.bytes.byteLength,
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

  return resolvedCachePathFromRelative(recording.cachePath);
}

function resolvedCachePathFromRelative(cachePath: string) {
  const normalized = cachePath.replaceAll("\\", "/");
  const resolved = path.resolve(cacheRoot, normalized);
  const relative = path.relative(cacheRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("recording_cache_path_outside_root");
  }

  return resolved;
}

async function readCachedFile(filePath: string) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("recording_cache_file_missing");
    }

    throw error;
  }
}

function cachePathFor(recording: RecordingSummary, input: StoreRecordingFileInput) {
  const folder = recording.source === "schedule" ? "scheduled" : "ad-hoc";
  const extension = extensionFor(input.fileName, input.mimeType);

  return path.posix.join(folder, `${recording.id}${extension}`);
}

function extensionFor(fileName?: string | null, mimeType?: string | null) {
  const extension = path.extname(path.basename(fileName ?? "")).toLowerCase();

  if ([".flac", ".mp3", ".wav"].includes(extension)) {
    return extension;
  }

  if (mimeType?.includes("flac")) {
    return ".flac";
  }

  if (mimeType?.includes("wav")) {
    return ".wav";
  }

  return ".mp3";
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
