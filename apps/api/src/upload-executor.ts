import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type {
  UploadChecksumVerification,
  UploadQueueItem,
  UploadQueueRunItem,
  UploadQueueRunSummary,
} from "@rakkr/shared";
import {
  createUploadProviderStore,
  type ResolvedUploadProviderConfig,
  type UploadProviderStore,
} from "./upload-providers.js";
import { defaultSmbClientFactory, uploadViaSmb, type SmbClientFactory } from "./upload-smb.js";
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
  smbClientFactory?: SmbClientFactory;
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
        ? await runProviderUpload(item, options, providerStore)
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
  options: UploadExecutorOptions,
  providerStore: UploadProviderStore,
): Promise<ProviderUploadResult> {
  if (!item.cachePath) {
    return { ok: false, reason: "cache_path_missing" };
  }

  if (item.provider === "stub") {
    return { ok: true };
  }

  try {
    const sourcePath = resolvedCachePath(item.cachePath);
    const sourceChecksum = await fileSha256(sourcePath);
    const expectedChecksum = normalizedSha256(item.checksum);

    if (expectedChecksum && expectedChecksum !== sourceChecksum.hex) {
      return { ok: false, reason: "source_checksum_mismatch" };
    }

    const config = await providerStore.resolveConfig(item.provider);
    const fileName = uploadFileName(item);

    if (item.provider === "smb") {
      await uploadViaSmb(
        { config, fileName, sourceChecksumHex: sourceChecksum.hex, sourcePath },
        options.smbClientFactory ?? defaultSmbClientFactory,
      );

      return {
        checksumVerification: {
          algorithm: "sha256",
          expected: sourceChecksum.prefixed,
          method: "file_copy_sha256",
          observed: sourceChecksum.prefixed,
          status: "matched",
        },
        ok: true,
      };
    }

    await uploadToS3(config, sourcePath, fileName, item, sourceChecksum, options.s3Client);

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

async function uploadToS3(
  config: ResolvedUploadProviderConfig,
  sourcePath: string,
  fileName: string,
  item: UploadQueueItem,
  sourceChecksum: FileSha256,
  injectedClient?: S3Sender,
) {
  const bucket = config.s3?.bucket;

  if (!bucket) {
    throw new Error("s3_bucket_missing");
  }

  const client = injectedClient ?? buildS3Client(config);

  await client.send(
    new PutObjectCommand({
      Body: createReadStream(sourcePath),
      Bucket: bucket,
      ChecksumSHA256: sourceChecksum.base64,
      ContentLength: (await stat(sourcePath)).size,
      ContentType: contentType(fileName),
      Key: s3Key(config.s3?.prefix, fileName),
      Metadata: {
        checksum: item.checksum ?? "",
        recording_id: item.recordingId,
        upload_queue_id: item.id,
      },
    }),
  );
}

function buildS3Client(config: ResolvedUploadProviderConfig): S3Client {
  const s3 = config.s3 ?? {};
  const clientConfig: S3ClientConfig = {
    // The SDK always requires a region; custom/compatible endpoints often ignore
    // it, so default to us-east-1 when only an endpoint is configured.
    region: s3.region && s3.region.length > 0 ? s3.region : "us-east-1",
  };

  if (s3.endpoint) {
    clientConfig.endpoint = s3.endpoint;
  }

  if (s3.forcePathStyle !== undefined) {
    clientConfig.forcePathStyle = s3.forcePathStyle;
  }

  if (s3.accessKeyId && config.s3SecretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    };
  }

  return new S3Client(clientConfig);
}

function s3Key(prefix: string | undefined, fileName: string) {
  const cleanPrefix = (prefix ?? "").replace(/^\/+|\/+$/g, "");

  return cleanPrefix ? path.posix.join(cleanPrefix, fileName) : fileName;
}

interface FileSha256 {
  base64: string;
  hex: string;
  prefixed: string;
}

async function fileSha256(filePath: string): Promise<FileSha256> {
  const bytes = await readFile(filePath);
  const hex = createHash("sha256").update(bytes).digest("hex");

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

function resolvedCachePath(cachePath: string) {
  const cacheRoot = path.resolve(process.env.RAKKR_RECORDING_CACHE_DIR ?? "data/recordings");
  const resolved = path.resolve(cacheRoot, cachePath.replaceAll("\\", "/"));
  const relative = path.relative(cacheRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cache_path_outside_root");
  }

  return resolved;
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
