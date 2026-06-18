import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecordingSummary, RecordingWaveformPreview } from "@rakkr/shared";

export interface CachedRecordingFile {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface StoredRecordingFile {
  cachePath: string;
  checksum: string;
  fileName: string;
  mimeType: string;
  size: number;
  waveformPreview?: RecordingWaveformPreview;
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
    checksum: sha256(input.bytes),
    fileName: recordingFileName({ ...recording, cachePath }),
    mimeType: mimeTypeFor(filePath),
    size: input.bytes.byteLength,
    waveformPreview: waveformPreviewFor(input.bytes, input.fileName, input.mimeType),
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

function sha256(bytes: Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function waveformPreviewFor(
  bytes: Buffer,
  fileName?: string | null,
  mimeType?: string | null,
): RecordingWaveformPreview | undefined {
  if (extensionFor(fileName, mimeType) !== ".wav") {
    return undefined;
  }

  return wavS16lePeakPreview(bytes);
}

function wavS16lePeakPreview(bytes: Buffer): RecordingWaveformPreview | undefined {
  const wav = wavData(bytes);

  if (!wav) {
    return undefined;
  }

  const frames = Math.floor(wav.dataSize / (wav.channelCount * 2));
  const bins = Math.min(96, frames);

  if (frames <= 0 || bins <= 0) {
    return undefined;
  }

  return {
    channelCount: wav.channelCount,
    generatedAt: new Date().toISOString(),
    peaks: Array.from({ length: bins }, (_, index) => peakForBin(bytes, wav, index, bins, frames)),
    sampleCount: frames,
    sampleRate: wav.sampleRate,
    source: "wav_s16le_peak",
  };
}

function wavData(bytes: Buffer) {
  if (
    bytes.byteLength < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return undefined;
  }

  let offset = 12;
  let channelCount = 0;
  let dataOffset = 0;
  let dataSize = 0;
  let sampleRate = 0;
  let supportedFormat = false;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + chunkSize, bytes.byteLength);

    if (chunkId === "fmt " && chunkSize >= 16 && end <= bytes.byteLength) {
      supportedFormat = bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 14) === 16;
      channelCount = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
    }

    if (chunkId === "data") {
      dataOffset = start;
      dataSize = Math.max(0, end - start);
    }

    offset = start + chunkSize + (chunkSize % 2);
  }

  if (!supportedFormat || channelCount <= 0 || sampleRate <= 0 || dataSize <= 0) {
    return undefined;
  }

  return { channelCount, dataOffset, dataSize, sampleRate };
}

function peakForBin(
  bytes: Buffer,
  wav: NonNullable<ReturnType<typeof wavData>>,
  index: number,
  bins: number,
  frames: number,
) {
  const startFrame = Math.floor((index * frames) / bins);
  const endFrame = Math.max(startFrame + 1, Math.floor(((index + 1) * frames) / bins));
  let peak = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const frameOffset = wav.dataOffset + frame * wav.channelCount * 2;

    for (let channel = 0; channel < wav.channelCount; channel += 1) {
      const sampleOffset = frameOffset + channel * 2;

      if (sampleOffset + 2 <= bytes.byteLength) {
        peak = Math.max(peak, Math.abs(bytes.readInt16LE(sampleOffset)) / 32768);
      }
    }
  }

  return Number(peak.toFixed(3));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
