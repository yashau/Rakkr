import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, SmbError } from "smb3-client";
import type { ResolvedUploadDestinationConfig } from "./upload-destinations.js";

// Minimal client surface the executor needs. The real `smb3-client` Client
// satisfies this structurally; tests inject a fake to avoid a live server.
export interface SmbClientLike {
  close(): Promise<void>;
  connect(): Promise<void>;
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
}

export type SmbClientFactory = (config: ResolvedUploadDestinationConfig) => SmbClientLike;

export interface SmbUploadInput {
  config: ResolvedUploadDestinationConfig;
  fileName: string;
  pathOverride?: string;
  sourceChecksumHex: string;
  sourcePath: string;
}

export interface SmbUploadResult {
  remotePath: string;
}

export const defaultSmbClientFactory: SmbClientFactory = (config) => {
  const smb = config.smb;

  return new Client({
    connectTimeout: 15_000,
    domain: smb?.domain && smb.domain.length > 0 ? smb.domain : undefined,
    encryption: "if-offered",
    host: smb?.server ?? "",
    password: config.smbPassword ?? "",
    port: smb?.port,
    requestTimeout: 60_000,
    signing: "if-offered",
    username: smb?.username ?? "",
  });
};

// Upload a cached file to an SMB share natively (no OS mount). The share is the
// first path segment of every operation; parent directories are created level by
// level (mkdir is not recursive), then the file is written and read back to
// verify the SHA-256 round-trips.
export async function uploadViaSmb(
  input: SmbUploadInput,
  factory: SmbClientFactory = defaultSmbClientFactory,
): Promise<SmbUploadResult> {
  const smb = input.config.smb;

  if (!smb?.server || !smb?.share || !smb?.username) {
    throw new Error("smb_config_incomplete");
  }

  const segments = smbPathSegments(smb.share, smb.path, input.pathOverride, input.fileName);
  const remotePath = segments.join("/");
  const client = factory(input.config);

  try {
    await client.connect();
    await ensureDirectories(client, segments);
    await client.writeFile(remotePath, await readFile(input.sourcePath));

    const written = await client.readFile(remotePath);

    if (createHash("sha256").update(written).digest("hex") !== input.sourceChecksumHex) {
      throw new Error("uploaded_checksum_mismatch");
    }

    return { remotePath };
  } catch (error) {
    throw new Error(smbFailureReason(error));
  } finally {
    await safeClose(client);
  }
}

async function ensureDirectories(client: SmbClientLike, segments: string[]) {
  // segments = [share, ...dirs, fileName]; create each dir level under the share.
  const dirSegments = segments.slice(0, -1);

  for (let depth = 2; depth <= dirSegments.length; depth += 1) {
    try {
      await client.mkdir(dirSegments.slice(0, depth).join("/"));
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  }
}

function smbPathSegments(
  share: string,
  uploadPath: string | undefined,
  pathOverride: string | undefined,
  fileName: string,
) {
  const segments = [normalizeSegment(share)];

  for (const part of `${uploadPath ?? ""}/${pathOverride ?? ""}`.split(/[\\/]+/)) {
    const normalized = normalizeSegment(part);

    if (normalized) {
      segments.push(normalized);
    }
  }

  segments.push(normalizeSegment(fileName));

  return segments.filter((segment) => segment.length > 0);
}

function normalizeSegment(value: string) {
  return value.replace(/^[\\/]+|[\\/]+$/g, "").trim();
}

function isAlreadyExists(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function smbFailureReason(error: unknown): string {
  if (error instanceof SmbError) {
    return `smb_${(error.code ?? error.statusName ?? "error").toLowerCase()}`;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "smb_upload_failed";
}

async function safeClose(client: SmbClientLike) {
  try {
    await client.close();
  } catch {
    // Best-effort teardown; the upload result already reflects success/failure.
  }
}
