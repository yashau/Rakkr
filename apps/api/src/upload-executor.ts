import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
  UploadChecksumVerification,
  UploadQueueItem,
  UploadQueueRunItem,
  UploadQueueRunSummary,
} from "@rakkr/shared";
import type { UploadProviderRuntimeStatus } from "@rakkr/shared";
import { createUploadProviderStore, type UploadProviderStore } from "./upload-providers.js";
import {
  failUploadQueueItem,
  listDueUploadQueueItems,
  startUploadQueueItem,
  succeedUploadQueueItem,
} from "./upload-queue.js";

interface UploadExecutorOptions {
  limit?: number;
  now?: Date;
  providerStore?: UploadProviderStore;
  recordingIds?: ReadonlySet<string>;
  s3Client?: S3Sender;
}

interface ProviderUploadResult {
  checksumVerification?: UploadChecksumVerification;
  ok: boolean;
  reason?: string;
}

interface S3Sender {
  send(command: PutObjectCommand): Promise<unknown>;
}

export async function runUploadQueueOnce(
  options: UploadExecutorOptions = {},
): Promise<UploadQueueRunSummary> {
  const limit = Math.max(0, options.limit ?? 10);
  const providerStore = options.providerStore ?? createUploadProviderStore();
  const dueItems = (await listDueUploadQueueItems(options.now))
    .filter((item) => !options.recordingIds || options.recordingIds.has(item.recordingId))
    .slice(0, limit);
  const items: UploadQueueRunItem[] = [];

  for (const dueItem of dueItems) {
    const item = await startUploadQueueItem(dueItem.id, options.now);

    if (!item) {
      continue;
    }

    const provider = await providerStore.findStatus(item.provider);
    const providerResult =
      provider.status === "ready"
        ? await runProviderUpload(item, provider, options)
        : { ok: false, reason: provider.reason ?? `provider_${provider.status}` };
    const next = providerResult.ok
      ? await succeedUploadQueueItem(item.id)
      : await failUploadQueueItem(item.id, providerResult.reason ?? "upload_failed");

    if (next) {
      items.push({
        itemId: next.id,
        checksumVerification: providerResult.checksumVerification,
        provider: next.provider,
        reason: next.lastError,
        recordingId: next.recordingId,
        status: next.status,
      });
    }
  }

  return {
    attempted: items.length,
    deferred: items.filter((item) => item.status === "retrying").length,
    failed: items.filter((item) => item.status === "failed").length,
    items,
    succeeded: items.filter((item) => item.status === "succeeded").length,
  };
}

async function runProviderUpload(
  item: UploadQueueItem,
  provider: UploadProviderRuntimeStatus,
  options: UploadExecutorOptions,
): Promise<ProviderUploadResult> {
  if (!item.cachePath) {
    return { ok: false, reason: "cache_path_missing" };
  }

  if (item.provider === "stub") {
    return { ok: true };
  }

  const target = item.target ?? provider.target;

  if (!target) {
    return { ok: false, reason: "upload_target_missing" };
  }

  try {
    const sourcePath = resolvedCachePath(item.cachePath);
    const sourceChecksum = await fileSha256(sourcePath);
    const expectedChecksum = normalizedSha256(item.checksum);

    if (expectedChecksum && expectedChecksum !== sourceChecksum.hex) {
      return { ok: false, reason: "source_checksum_mismatch" };
    }

    if (item.provider === "smb") {
      const targetPath = await copyToMountedShare(sourcePath, target, uploadFileName(item));
      const targetChecksum = await fileSha256(targetPath);

      if (targetChecksum.hex !== sourceChecksum.hex) {
        return { ok: false, reason: "uploaded_checksum_mismatch" };
      }

      return {
        checksumVerification: {
          algorithm: "sha256",
          expected: sourceChecksum.prefixed,
          method: "file_copy_sha256",
          observed: targetChecksum.prefixed,
          status: "matched",
        },
        ok: true,
      };
    }

    await uploadToS3(
      sourcePath,
      target,
      uploadFileName(item),
      item,
      sourceChecksum,
      options.s3Client,
    );

    return {
      checksumVerification: {
        algorithm: "sha256",
        expected: sourceChecksum.prefixed,
        method: "s3_checksum_sha256",
        status: "provider_validated",
      },
      ok: true,
    };
  } catch (error) {
    return { ok: false, reason: uploadFailureReason(item.provider, error) };
  }
}

async function copyToMountedShare(sourcePath: string, target: string, fileName: string) {
  const targetRoot = filesystemTargetRoot(target);
  const targetPath = path.join(targetRoot, fileName);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);

  return targetPath;
}

async function uploadToS3(
  sourcePath: string,
  target: string,
  fileName: string,
  item: UploadQueueItem,
  sourceChecksum: FileSha256,
  s3Client?: S3Sender,
) {
  const client = s3Client ?? new S3Client({});
  const destination = s3Destination(target, fileName);
  const sourceStats = await stat(sourcePath);

  await client.send(
    new PutObjectCommand({
      Body: createReadStream(sourcePath),
      Bucket: destination.bucket,
      ChecksumSHA256: sourceChecksum.base64,
      ContentLength: sourceStats.size,
      ContentType: contentType(fileName),
      Key: destination.key,
      Metadata: {
        checksum: item.checksum ?? "",
        recording_id: item.recordingId,
        upload_queue_id: item.id,
      },
    }),
  );
}

interface FileSha256 {
  base64: string;
  hex: string;
  prefixed: string;
}

async function fileSha256(filePath: string): Promise<FileSha256> {
  const bytes = await readFile(filePath);
  const hash = createHash("sha256").update(bytes);
  const hex = hash.digest("hex");

  return {
    base64: Buffer.from(hex, "hex").toString("base64"),
    hex,
    prefixed: `sha256:${hex}`,
  };
}

function normalizedSha256(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const candidate = value.replace(/^sha256:/i, "").toLowerCase();

  return /^[a-f0-9]{64}$/.test(candidate) ? candidate : undefined;
}

function contentType(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".flac") {
    return "audio/flac";
  }

  if (extension === ".wav") {
    return "audio/wav";
  }

  return "audio/mpeg";
}

function filesystemTargetRoot(target: string) {
  if (target.startsWith("smb://")) {
    throw new Error("smb_target_must_be_mounted");
  }

  if (target.startsWith("file://")) {
    return fileURLToPath(target);
  }

  return path.resolve(target);
}

function resolvedCachePath(cachePath: string) {
  const cacheRoot = path.resolve(process.env.RAKKR_RECORDING_CACHE_DIR ?? "data/recordings");
  const resolved = path.resolve(cacheRoot, cachePath.replaceAll("\\", "/"));
  const relative = path.relative(cacheRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cache_path_outside_root");
  }

  return resolved;
}

function s3Destination(target: string, fileName: string) {
  const url = new URL(target);

  if (url.protocol !== "s3:" || !url.hostname) {
    throw new Error("s3_target_invalid");
  }

  return {
    bucket: url.hostname,
    key: path.posix.join(url.pathname.replace(/^\/+|\/+$/g, ""), fileName),
  };
}

function uploadFailureReason(provider: UploadQueueItem["provider"], error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return provider === "s3" ? "s3_upload_failed" : "smb_upload_failed";
}

function uploadFileName(item: UploadQueueItem) {
  return path.basename(item.fileName ?? item.cachePath ?? `${item.recordingId}.mp3`);
}
