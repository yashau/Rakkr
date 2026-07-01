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
  createUploadDestinationStore,
  type ResolvedUploadDestinationConfig,
  type UploadDestinationStore,
} from "./upload-destinations.js";
import { defaultSmbClientFactory, uploadViaSmb, type SmbClientFactory } from "./upload-smb.js";
import {
  failUploadQueueItem,
  listDueUploadQueueItems,
  startUploadQueueItem,
  succeedUploadQueueItem,
} from "./upload-queue.js";

interface UploadExecutorOptions {
  destinationStore?: UploadDestinationStore;
  limit?: number;
  now?: Date;
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
  const destinationStore = options.destinationStore ?? createUploadDestinationStore();
  const dueItems = (await listDueUploadQueueItems(options.now))
    .filter((item) => !options.recordingIds || options.recordingIds.has(item.recordingId))
    .slice(0, limit);
  const items: UploadQueueRunItem[] = [];

  for (const dueItem of dueItems) {
    const item = await startUploadQueueItem(dueItem.id, options.now);

    if (!item) {
      continue;
    }

    const providerResult = await runProviderUpload(item, options, destinationStore);
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
  destinationStore: UploadDestinationStore,
): Promise<ProviderUploadResult> {
  if (!item.cachePath) {
    return { ok: false, reason: "cache_path_missing" };
  }

  if (item.provider === "stub") {
    return { ok: true };
  }

  if (!item.destinationId) {
    return { ok: false, reason: "destination_missing" };
  }

  const destination = await destinationStore.find(item.destinationId);

  if (!destination) {
    return { ok: false, reason: "destination_not_found" };
  }

  if (destination.status !== "ready") {
    return { ok: false, reason: destination.reason ?? `destination_${destination.status}` };
  }

  try {
    const sourcePath = resolvedCachePath(item.cachePath);
    const sourceChecksum = await fileSha256(sourcePath);
    const expectedChecksum = normalizedSha256(item.checksum);

    if (expectedChecksum && expectedChecksum !== sourceChecksum.hex) {
      return { ok: false, reason: "source_checksum_mismatch" };
    }

    const config = await destinationStore.resolveConfig(item.destinationId);

    if (!config) {
      return { ok: false, reason: "destination_not_found" };
    }

    const fileName = uploadFileName(item);

    if (item.provider === "smb") {
      await uploadViaSmb(
        {
          config,
          fileName,
          pathOverride: item.pathOverride,
          sourceChecksumHex: sourceChecksum.hex,
          sourcePath,
        },
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
        // Real AWS S3 validates the trailing ChecksumSHA256; an S3-compatible
        // custom endpoint may silently ignore it, so only claim it was validated
        // when we're talking to AWS (no custom endpoint configured).
        status: config.s3?.endpoint ? "provider_declared" : "provider_validated",
      },
      ok: true,
    };
  } catch (error) {
    return { ok: false, reason: uploadFailureReason(item.provider, error) };
  }
}

async function uploadToS3(
  config: ResolvedUploadDestinationConfig,
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
      Key: s3Key(config.s3?.prefix, item.pathOverride, fileName),
      Metadata: {
        checksum: item.checksum ?? "",
        recording_id: item.recordingId,
        upload_queue_id: item.id,
      },
    }),
  );
}

function buildS3Client(config: ResolvedUploadDestinationConfig): S3Client {
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

function s3Key(prefix: string | undefined, pathOverride: string | undefined, fileName: string) {
  // Split into segments and drop empty/`.`/`..` rather than `path.posix.join`,
  // which RESOLVES `..` — an operator-set pathOverride (or prefix) like
  // `../../x` would otherwise escape the configured prefix, nullify it (write to
  // the bucket root), or collide with a different pathOverride that resolves to
  // the same key (silent overwrite). Mirrors the SMB hardening (G37).
  const segments = [prefix, pathOverride, fileName]
    .flatMap((value) => (value ?? "").split(/[\\/]+/))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  return segments.join("/");
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
