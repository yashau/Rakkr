import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  durationSeconds?: number;
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
const decodedPreviewMaxBytes = positiveInteger(
  process.env.RAKKR_AUDIO_PREVIEW_MAX_BYTES,
  64 * 1024 * 1024,
);
const audioToolTimeoutMs = positiveInteger(process.env.RAKKR_AUDIO_TOOL_TIMEOUT_MS, 15_000);

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

export async function deleteRecordingCacheFile(recording: RecordingSummary) {
  const filePath = resolvedCachePath(recording);

  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function storeRecordingFile(
  recording: RecordingSummary,
  input: StoreRecordingFileInput,
): Promise<StoredRecordingFile> {
  const cachePath = cachePathFor(recording, input);
  const filePath = resolvedCachePathFromRelative(cachePath);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, input.bytes);
  const analysis = await audioAnalysisFor(filePath, input);

  return {
    cachePath,
    checksum: sha256(input.bytes),
    durationSeconds: analysis.durationSeconds,
    fileName: recordingFileName({ ...recording, cachePath }),
    mimeType: mimeTypeFor(filePath),
    size: input.bytes.byteLength,
    waveformPreview: analysis.waveformPreview,
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

async function audioAnalysisFor(filePath: string, input: StoreRecordingFileInput) {
  const extension = extensionFor(input.fileName, input.mimeType);
  const directPreview =
    extension === ".wav" ? wavS16lePeakPreview(input.bytes, "wav_s16le_peak") : undefined;

  if (directPreview) {
    return {
      durationSeconds: durationSecondsFor(directPreview),
      waveformPreview: directPreview,
    };
  }

  const [durationSeconds, decodedPreview] = await Promise.all([
    probeAudioDurationSeconds(filePath),
    decodedWaveformPreview(filePath),
  ]);

  return {
    durationSeconds,
    waveformPreview: decodedPreview,
  };
}

function wavS16lePeakPreview(
  bytes: Buffer,
  source: RecordingWaveformPreview["source"],
): RecordingWaveformPreview | undefined {
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
    source,
  };
}

async function decodedWaveformPreview(
  filePath: string,
): Promise<RecordingWaveformPreview | undefined> {
  const invocation = audioToolInvocation("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-acodec",
    "pcm_s16le",
    "-f",
    "wav",
    "-",
  ]);
  const decoded = await runAudioTool(invocation.command, invocation.args, decodedPreviewMaxBytes);

  return decoded ? wavS16lePeakPreview(decoded, "ffmpeg_decoded_peak") : undefined;
}

async function probeAudioDurationSeconds(filePath: string) {
  const invocation = audioToolInvocation("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const output = await runAudioTool(invocation.command, invocation.args, 1024 * 1024);

  if (!output) {
    return undefined;
  }

  const parsed = parseJsonObject(output.toString("utf8"));
  const duration = Number(record(parsed.format)?.duration);

  return Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.round(duration)) : undefined;
}

function audioToolInvocation(tool: "ffmpeg" | "ffprobe", args: string[]) {
  const upperTool = tool.toUpperCase();
  const command = process.env[`RAKKR_${upperTool}_COMMAND`] ?? tool;
  const prefix = argsPrefix(process.env[`RAKKR_${upperTool}_ARGS_PREFIX`]);

  return { args: [...prefix, ...args], command };
}

function argsPrefix(value: string | undefined) {
  if (!value?.trim()) {
    return [];
  }

  if (value.trim().startsWith("[")) {
    const parsed = parseJson(value);

    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  }

  return value.split(/\s+/).filter(Boolean);
}

function runAudioTool(
  command: string,
  args: string[],
  maxBytes: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let done = false;
    let size = 0;
    const timeout = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, audioToolTimeoutMs);

    function finish(value: Buffer | undefined) {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        resolve(value);
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }

      size += chunk.byteLength;

      if (size > maxBytes) {
        child.kill();
        finish(undefined);
        return;
      }

      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks) : undefined));
  });
}

function durationSecondsFor(waveform: RecordingWaveformPreview) {
  const duration = waveform.sampleCount / waveform.sampleRate;

  return Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.round(duration)) : undefined;
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

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: string) {
  return record(parseJson(value)) ?? {};
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
