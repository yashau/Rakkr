import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  uploadProviderSchema,
  uploadQueueItemSchema,
  type RecordingSummary,
  type UploadProvider,
  type UploadQueueItem,
} from "@rakkr/shared";
import { recordingFileName } from "./recording-cache.js";

interface EnqueueUploadInput {
  maxAttempts?: number;
  policyId?: string;
  provider?: UploadProvider;
  reason?: string;
  target?: string;
}

const queuePath = path.resolve(
  process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH ?? "data/upload-queue.json",
);
const activeStatuses = new Set<UploadQueueItem["status"]>(["queued", "retrying", "failed"]);

class UploadQueueStore {
  private readonly items: UploadQueueItem[] = loadQueueItems();

  async enqueue(recording: RecordingSummary, input: EnqueueUploadInput = {}) {
    const provider = input.provider ?? "stub";
    const existing = this.items.find(
      (item) =>
        item.recordingId === recording.id &&
        item.provider === provider &&
        activeStatuses.has(item.status),
    );

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const item: UploadQueueItem = {
      attemptCount: 0,
      cachePath: recording.cachePath,
      checksum: recording.checksum,
      createdAt: now,
      fileName: recordingFileName(recording),
      id: `upload_${randomUUID()}`,
      lastError: input.reason ?? "provider_not_configured",
      maxAttempts: input.maxAttempts ?? Number(process.env.RAKKR_UPLOAD_QUEUE_MAX_ATTEMPTS ?? 5),
      nextAttemptAt: now,
      provider,
      recordingId: recording.id,
      status: "queued",
      target: input.target,
      updatedAt: now,
      uploadPolicyId: input.policyId,
    };

    this.items.unshift(item);
    this.persist();

    return item;
  }

  async list() {
    return [...this.items].sort((left, right) =>
      left.nextAttemptAt.localeCompare(right.nextAttemptAt),
    );
  }

  async retry(itemId: string) {
    const item = this.items.find((candidate) => candidate.id === itemId);

    if (!item) {
      return undefined;
    }

    const nextAttempt = item.attemptCount + 1;
    const now = new Date().toISOString();

    item.attemptCount = nextAttempt;
    item.lastError = "provider_not_configured";
    item.nextAttemptAt = retryAt(nextAttempt);
    item.status = nextAttempt >= item.maxAttempts ? "failed" : "retrying";
    item.updatedAt = now;
    this.persist();

    return item;
  }

  private persist() {
    mkdirSync(path.dirname(queuePath), { recursive: true });
    const tempPath = `${queuePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        items: this.items,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, queuePath);
  }
}

const uploadQueueStore = new UploadQueueStore();

export function enqueueRecordingUpload(recording: RecordingSummary, input?: EnqueueUploadInput) {
  return uploadQueueStore.enqueue(recording, input);
}

export function listUploadQueueItems() {
  return uploadQueueStore.list();
}

export function retryUploadQueueItem(itemId: string) {
  return uploadQueueStore.retry(itemId);
}

function retryAt(attemptCount: number) {
  const seconds = Math.min(3600, 60 * 2 ** Math.max(0, attemptCount - 1));

  return new Date(Date.now() + seconds * 1000).toISOString();
}

function loadQueueItems() {
  if (!existsSync(queuePath)) {
    return [];
  }

  const raw = readFileSync(queuePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const items = isQueueStore(parsed) ? parsed.items : parsed;

  if (!Array.isArray(items)) {
    throw new Error("upload_queue_store_invalid");
  }

  return items.map((item) => uploadQueueItemSchema.parse(item));
}

function isQueueStore(value: unknown): value is { items: unknown[] } {
  return typeof value === "object" && value !== null && "items" in value;
}

export function uploadProviderFromValue(value: unknown) {
  return uploadProviderSchema.catch("stub").parse(value);
}
