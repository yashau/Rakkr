import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { UploadQueueItem, UploadQueueRunItem, UploadQueueRunSummary } from "@rakkr/shared";
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
  s3Client?: S3Sender;
}

interface ProviderUploadResult {
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
  const dueItems = (await listDueUploadQueueItems(options.now)).slice(0, limit);
  const items: UploadQueueRunItem[] = [];

  for (const dueItem of dueItems) {
    const item = await startUploadQueueItem(dueItem.id);

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

    if (item.provider === "smb") {
      await copyToMountedShare(sourcePath, target, uploadFileName(item));

      return { ok: true };
    }

    await uploadToS3(sourcePath, target, uploadFileName(item), item, options.s3Client);

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: uploadFailureReason(item.provider, error) };
  }
}

async function copyToMountedShare(sourcePath: string, target: string, fileName: string) {
  const targetRoot = filesystemTargetRoot(target);
  const targetPath = path.join(targetRoot, fileName);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function uploadToS3(
  sourcePath: string,
  target: string,
  fileName: string,
  item: UploadQueueItem,
  s3Client?: S3Sender,
) {
  const client = s3Client ?? new S3Client({});
  const destination = s3Destination(target, fileName);
  const sourceStats = await stat(sourcePath);

  await client.send(
    new PutObjectCommand({
      Body: createReadStream(sourcePath),
      Bucket: destination.bucket,
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
