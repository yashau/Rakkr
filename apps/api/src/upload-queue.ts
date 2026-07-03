import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  and,
  createDatabase,
  eq,
  inArray,
  lte,
  or,
  sql,
  uploadQueueItems as uploadQueueItemsTable,
} from "@rakkr/db";
import { DatabaseUnavailableError } from "./database-unavailable.js";
import {
  uploadProviderSchema,
  uploadQueueItemSchema,
  type RecordingSummary,
  type UploadProvider,
  type UploadQueueItem,
} from "@rakkr/shared";
import { recordingFileName } from "./recording-cache.js";

type UploadQueueItemRow = typeof uploadQueueItemsTable.$inferSelect;

interface EnqueueUploadInput {
  // Per-item file overrides. When uploading a chunk these point at the chunk's
  // own cached object instead of the recording's primary file.
  cachePath?: string;
  checksum?: string;
  chunkId?: string;
  chunkIndex?: number;
  destinationId?: string;
  fileName?: string;
  maxAttempts?: number;
  pathOverride?: string;
  policyId?: string;
  provider?: UploadProvider;
  reason?: string;
  target?: string;
}

const queuePath = path.resolve(
  process.env.RAKKR_UPLOAD_QUEUE_STORE_PATH ?? "data/upload-queue.json",
);
const activeStatuses = new Set<UploadQueueItem["status"]>(["queued", "retrying", "failed"]);
const dueStatuses = new Set<UploadQueueItem["status"]>(["queued", "retrying"]);

interface UploadQueueStore {
  deleteForRecording(recordingId: string): Promise<void>;
  due(now?: Date): Promise<UploadQueueItem[]>;
  enqueue(recording: RecordingSummary, input?: EnqueueUploadInput): Promise<UploadQueueItem>;
  fail(itemId: string, reason: string): Promise<UploadQueueItem | undefined>;
  list(): Promise<UploadQueueItem[]>;
  retry(itemId: string): Promise<UploadQueueItem | undefined>;
  start(itemId: string, now?: Date): Promise<UploadQueueItem | undefined>;
  succeed(itemId: string): Promise<UploadQueueItem | undefined>;
}

class JsonUploadQueueStore implements UploadQueueStore {
  private readonly items: UploadQueueItem[] = loadQueueItems();

  async enqueue(recording: RecordingSummary, input: EnqueueUploadInput = {}) {
    const provider = input.provider ?? "stub";
    const existing = this.items.find(
      (item) =>
        item.recordingId === recording.id &&
        item.provider === provider &&
        reusableUploadQueueItem(item, recording, input),
    );

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const item: UploadQueueItem = {
      attemptCount: 0,
      cachePath: input.cachePath ?? recording.cachePath,
      checksum: input.checksum ?? recording.checksum,
      chunkId: input.chunkId,
      chunkIndex: input.chunkIndex,
      createdAt: now,
      destinationId: input.destinationId,
      fileName: input.fileName ?? recordingFileName(recording),
      id: `upload_${randomUUID()}`,
      lastError: input.reason ?? "provider_not_configured",
      maxAttempts: input.maxAttempts ?? Number(process.env.RAKKR_UPLOAD_QUEUE_MAX_ATTEMPTS ?? 5),
      nextAttemptAt: now,
      pathOverride: input.pathOverride,
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

  async deleteForRecording(recordingId: string) {
    let removed = false;

    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.recordingId === recordingId) {
        this.items.splice(index, 1);
        removed = true;
      }
    }

    if (removed) {
      this.persist();
    }
  }

  async list() {
    return [...this.items].sort((left, right) =>
      left.nextAttemptAt.localeCompare(right.nextAttemptAt),
    );
  }

  async due(now = new Date()) {
    const nowIso = now.toISOString();

    return this.items
      .filter((item) => dueStatuses.has(item.status) && item.nextAttemptAt <= nowIso)
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt));
  }

  async start(itemId: string, now = new Date()) {
    const item = this.items.find(
      (candidate) => candidate.id === itemId && dueStatuses.has(candidate.status),
    );

    if (!item) {
      return undefined;
    }

    const nowIso = now.toISOString();

    item.attemptCount += 1;
    item.lastError = undefined;
    item.nextAttemptAt = uploadLeaseExpiresAt(now);
    item.status = "retrying";
    item.updatedAt = nowIso;
    this.persist();

    return item;
  }

  async succeed(itemId: string) {
    const item = this.items.find((candidate) => candidate.id === itemId);

    if (!item) {
      return undefined;
    }

    const now = new Date().toISOString();

    item.lastError = undefined;
    item.nextAttemptAt = now;
    item.status = "succeeded";
    item.updatedAt = now;
    this.persist();

    return item;
  }

  async fail(itemId: string, reason: string) {
    const item = this.items.find((candidate) => candidate.id === itemId);

    if (!item) {
      return undefined;
    }

    const now = new Date().toISOString();
    const failed = item.attemptCount >= item.maxAttempts;

    item.lastError = reason;
    item.nextAttemptAt = failed ? now : retryAt(item.attemptCount);
    item.status = failed ? "failed" : "retrying";
    item.updatedAt = now;
    this.persist();

    return item;
  }

  async retry(itemId: string) {
    const item = this.items.find((candidate) => candidate.id === itemId);

    if (!item) {
      return undefined;
    }

    const now = new Date().toISOString();

    // Operator-initiated retry: give the item a fresh attempt budget so a
    // terminally-`failed`/`cancelled` upload is genuinely re-attempted by the
    // runner (`dueStatuses` includes `retrying`), due immediately. Previously
    // this incremented an already-maxed `attemptCount`, so a failed item stayed
    // failed and the retry action was a no-op.
    item.attemptCount = 0;
    item.lastError = "provider_not_configured";
    item.nextAttemptAt = now;
    item.status = "retrying";
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

type UploadQueueDatabase = ReturnType<typeof createDatabase>;
// The db handle or a transaction handle — lets findItem/writeItem run inside the
// succeed/fail/retry transactions that serialize the read-modify-write.
type UploadQueueExecutor =
  | UploadQueueDatabase
  | Parameters<Parameters<UploadQueueDatabase["transaction"]>[0]>[0];

class PostgresUploadQueueStore implements UploadQueueStore {
  private dbAvailable = true;
  private readonly db: UploadQueueDatabase;

  constructor(private readonly fallback: UploadQueueStore) {
    this.db = createDatabase(process.env.DATABASE_URL!);
  }

  async enqueue(recording: RecordingSummary, input: EnqueueUploadInput = {}) {
    if (!this.dbAvailable) {
      return this.fallback.enqueue(recording, input);
    }

    try {
      const provider = input.provider ?? "stub";
      const existingRows = await this.db
        .select()
        .from(uploadQueueItemsTable)
        .where(
          and(
            eq(uploadQueueItemsTable.recordingId, recording.id),
            eq(uploadQueueItemsTable.provider, provider),
          ),
        );
      const existing = existingRows
        .map(queueItemFromRow)
        .find((item) => reusableUploadQueueItem(item, recording, input));

      if (existing) {
        return existing;
      }

      const now = new Date().toISOString();
      const item = uploadQueueItemSchema.parse({
        attemptCount: 0,
        cachePath: input.cachePath ?? recording.cachePath,
        checksum: input.checksum ?? recording.checksum,
        chunkId: input.chunkId,
        chunkIndex: input.chunkIndex,
        createdAt: now,
        destinationId: input.destinationId,
        fileName: input.fileName ?? recordingFileName(recording),
        id: `upload_${randomUUID()}`,
        lastError: input.reason ?? "provider_not_configured",
        maxAttempts: input.maxAttempts ?? Number(process.env.RAKKR_UPLOAD_QUEUE_MAX_ATTEMPTS ?? 5),
        nextAttemptAt: now,
        pathOverride: input.pathOverride,
        provider,
        recordingId: recording.id,
        status: "queued",
        target: input.target,
        updatedAt: now,
        uploadPolicyId: input.policyId,
      });

      await this.writeItem(item);

      return item;
    } catch (error) {
      await this.failover("upload queue enqueue unavailable; using JSON store", error);
      return this.fallback.enqueue(recording, input);
    }
  }

  async list() {
    if (!this.dbAvailable) {
      return this.fallback.list();
    }

    try {
      const rows = await this.db.select().from(uploadQueueItemsTable);

      return rows
        .map(queueItemFromRow)
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt));
    } catch (error) {
      await this.failover("upload queue query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async due(now = new Date()) {
    if (!this.dbAvailable) {
      return this.fallback.due(now);
    }

    try {
      const rows = await this.db
        .select()
        .from(uploadQueueItemsTable)
        .where(
          and(
            or(
              eq(uploadQueueItemsTable.status, "queued"),
              eq(uploadQueueItemsTable.status, "retrying"),
            ),
            lte(uploadQueueItemsTable.nextAttemptAt, now),
          ),
        );

      return rows
        .map(queueItemFromRow)
        .filter((item) => dueStatuses.has(item.status))
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt));
    } catch (error) {
      await this.failover("upload queue due query unavailable; using JSON store", error);
      return this.fallback.due(now);
    }
  }

  async start(itemId: string, now = new Date()) {
    if (!this.dbAvailable) {
      return this.fallback.start(itemId, now);
    }

    try {
      // Atomic claim: transition to `retrying` (and increment attemptCount) only
      // if the row is still due. A find-then-write races two runners (e.g. >1 API
      // replica) into a double increment + double upload — this mirrors the
      // recording-job CAS. Zero returned rows means another runner won the claim.
      const [updated] = await this.db
        .update(uploadQueueItemsTable)
        .set({
          attemptCount: sql`${uploadQueueItemsTable.attemptCount} + 1`,
          lastError: null,
          nextAttemptAt: new Date(uploadLeaseExpiresAt(now)),
          status: "retrying",
          updatedAt: now,
        })
        .where(
          and(
            eq(uploadQueueItemsTable.id, itemId),
            inArray(uploadQueueItemsTable.status, [...dueStatuses]),
          ),
        )
        .returning();

      return updated ? queueItemFromRow(updated) : undefined;
    } catch (error) {
      await this.failover("upload queue start unavailable; using JSON store", error);
      return this.fallback.start(itemId, now);
    }
  }

  async succeed(itemId: string) {
    if (!this.dbAvailable) {
      return this.fallback.succeed(itemId);
    }

    try {
      // Lock the row for the read-modify-write so a concurrent operator retry()
      // or another runner tick cannot clobber this transition (last-writer-wins).
      return await this.db.transaction(async (tx) => {
        const item = await this.findItem(itemId, tx, true);

        if (!item) {
          return undefined;
        }

        const now = new Date().toISOString();
        const updated = uploadQueueItemSchema.parse({
          ...item,
          lastError: undefined,
          nextAttemptAt: now,
          status: "succeeded",
          updatedAt: now,
        });

        await this.writeItem(updated, tx);

        return updated;
      });
    } catch (error) {
      await this.failover("upload queue success unavailable; using JSON store", error);
      return this.fallback.succeed(itemId);
    }
  }

  async fail(itemId: string, reason: string) {
    if (!this.dbAvailable) {
      return this.fallback.fail(itemId, reason);
    }

    try {
      // Lock the row for the read-modify-write (see succeed()); the failed/retry
      // decision reads attemptCount, which a concurrent writer must not race.
      return await this.db.transaction(async (tx) => {
        const item = await this.findItem(itemId, tx, true);

        if (!item) {
          return undefined;
        }

        const now = new Date().toISOString();
        const failed = item.attemptCount >= item.maxAttempts;
        const updated = uploadQueueItemSchema.parse({
          ...item,
          lastError: reason,
          nextAttemptAt: failed ? now : retryAt(item.attemptCount),
          status: failed ? "failed" : "retrying",
          updatedAt: now,
        });

        await this.writeItem(updated, tx);

        return updated;
      });
    } catch (error) {
      await this.failover("upload queue failure unavailable; using JSON store", error);
      return this.fallback.fail(itemId, reason);
    }
  }

  async retry(itemId: string) {
    if (!this.dbAvailable) {
      return this.fallback.retry(itemId);
    }

    try {
      // Lock the row for the read-modify-write so the operator's budget reset is
      // not clobbered by a concurrent runner succeed/fail (see succeed()).
      return await this.db.transaction(async (tx) => {
        const item = await this.findItem(itemId, tx, true);

        if (!item) {
          return undefined;
        }

        const now = new Date().toISOString();
        // Operator retry resets the attempt budget so the runner re-attempts a
        // terminally-failed item (see the JSON store for the rationale).
        const updated = uploadQueueItemSchema.parse({
          ...item,
          attemptCount: 0,
          lastError: "provider_not_configured",
          nextAttemptAt: now,
          status: "retrying",
          updatedAt: now,
        });

        await this.writeItem(updated, tx);

        return updated;
      });
    } catch (error) {
      await this.failover("upload queue retry unavailable; using JSON store", error);
      return this.fallback.retry(itemId);
    }
  }

  private async findItem(
    itemId: string,
    executor: UploadQueueExecutor = this.db,
    forUpdate = false,
  ) {
    const base = executor
      .select()
      .from(uploadQueueItemsTable)
      .where(eq(uploadQueueItemsTable.id, itemId));
    // FOR UPDATE (only valid inside a transaction) locks the row so the
    // succeed/fail/retry read-modify-write serializes against a concurrent writer.
    const [row] = await (forUpdate ? base.for("update") : base.limit(1));

    return row ? queueItemFromRow(row) : undefined;
  }

  async deleteForRecording(recordingId: string) {
    if (!this.dbAvailable) {
      await this.fallback.deleteForRecording(recordingId);
      return;
    }

    try {
      await this.db
        .delete(uploadQueueItemsTable)
        .where(eq(uploadQueueItemsTable.recordingId, recordingId));
    } catch (error) {
      await this.failover("upload queue delete unavailable; using JSON store", error);
      await this.fallback.deleteForRecording(recordingId);
    }
  }

  private async writeItem(item: UploadQueueItem, executor: UploadQueueExecutor = this.db) {
    await executor
      .insert(uploadQueueItemsTable)
      .values(queueItemToRow(item))
      .onConflictDoUpdate({
        set: {
          attemptCount: item.attemptCount,
          cachePath: item.cachePath ?? null,
          checksum: item.checksum ?? null,
          chunkId: item.chunkId ?? null,
          chunkIndex: item.chunkIndex ?? null,
          destinationId: item.destinationId ?? null,
          fileName: item.fileName,
          lastError: item.lastError ?? null,
          maxAttempts: item.maxAttempts,
          nextAttemptAt: new Date(item.nextAttemptAt),
          pathOverride: item.pathOverride ?? null,
          provider: item.provider,
          recordingId: item.recordingId,
          status: item.status,
          target: item.target ?? null,
          updatedAt: new Date(item.updatedAt),
          uploadPolicyId: item.uploadPolicyId ?? null,
        },
        target: uploadQueueItemsTable.id,
      });
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }
}

function createUploadQueueStore() {
  const fallback = new JsonUploadQueueStore();

  return process.env.DATABASE_URL ? new PostgresUploadQueueStore(fallback) : fallback;
}

const uploadQueueStore = createUploadQueueStore();

export function enqueueRecordingUpload(recording: RecordingSummary, input?: EnqueueUploadInput) {
  return uploadQueueStore.enqueue(recording, input);
}

export function listUploadQueueItems() {
  return uploadQueueStore.list();
}

// Remove every queue item for a recording (used when the recording is deleted —
// upload_queue_items has no FK cascade, and orphaned items would otherwise be
// retried forever with cache_path_missing).
export async function deleteUploadQueueItemsForRecording(recordingId: string) {
  await uploadQueueStore.deleteForRecording(recordingId);
}

export function listDueUploadQueueItems(now?: Date) {
  return uploadQueueStore.due(now);
}

export function startUploadQueueItem(itemId: string, now?: Date) {
  return uploadQueueStore.start(itemId, now);
}

export function succeedUploadQueueItem(itemId: string) {
  return uploadQueueStore.succeed(itemId);
}

export function failUploadQueueItem(itemId: string, reason: string) {
  return uploadQueueStore.fail(itemId, reason);
}

export function retryUploadQueueItem(itemId: string) {
  return uploadQueueStore.retry(itemId);
}

function retryAt(attemptCount: number) {
  const seconds = Math.min(3600, 60 * 2 ** Math.max(0, attemptCount - 1));

  return new Date(Date.now() + seconds * 1000).toISOString();
}

function uploadLeaseExpiresAt(now: Date) {
  return new Date(now.getTime() + uploadQueueLeaseSeconds() * 1_000).toISOString();
}

function uploadQueueLeaseSeconds() {
  return positiveInteger(process.env.RAKKR_UPLOAD_QUEUE_LEASE_SECONDS, 15 * 60);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function reusableUploadQueueItem(
  item: UploadQueueItem,
  recording: RecordingSummary,
  input: EnqueueUploadInput,
) {
  // Items pinned to different destinations (even of the same kind) are distinct.
  if (item.destinationId !== input.destinationId) {
    return false;
  }

  // Chunk items never collapse into one another or into the whole-recording item.
  if (item.chunkId !== input.chunkId) {
    return false;
  }

  // An active item only dedups a genuine re-enqueue of the SAME logical upload.
  // A recording can carry several policies pointing at one destination with
  // different subfolders (`pathOverride`) or retention, so — mirroring the
  // succeeded branch below — distinct policy/path must NOT collapse, or the
  // other policies' uploads are silently dropped.
  if (activeStatuses.has(item.status)) {
    return item.pathOverride === input.pathOverride && item.uploadPolicyId === input.policyId;
  }

  return (
    item.status === "succeeded" &&
    item.cachePath === (input.cachePath ?? recording.cachePath) &&
    item.checksum === (input.checksum ?? recording.checksum) &&
    item.pathOverride === input.pathOverride &&
    item.target === input.target &&
    item.uploadPolicyId === input.policyId
  );
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

function queueItemFromRow(row: UploadQueueItemRow): UploadQueueItem {
  return uploadQueueItemSchema.parse({
    attemptCount: row.attemptCount,
    cachePath: row.cachePath ?? undefined,
    checksum: row.checksum ?? undefined,
    chunkId: row.chunkId ?? undefined,
    chunkIndex: row.chunkIndex ?? undefined,
    createdAt: row.createdAt.toISOString(),
    destinationId: row.destinationId ?? undefined,
    fileName: row.fileName,
    id: row.id,
    lastError: row.lastError ?? undefined,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    pathOverride: row.pathOverride ?? undefined,
    provider: row.provider,
    recordingId: row.recordingId,
    status: row.status,
    target: row.target ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
    uploadPolicyId: row.uploadPolicyId ?? undefined,
  });
}

function queueItemToRow(item: UploadQueueItem) {
  return {
    attemptCount: item.attemptCount,
    cachePath: item.cachePath ?? null,
    checksum: item.checksum ?? null,
    chunkId: item.chunkId ?? null,
    chunkIndex: item.chunkIndex ?? null,
    createdAt: new Date(item.createdAt),
    destinationId: item.destinationId ?? null,
    fileName: item.fileName ?? path.basename(item.cachePath ?? `${item.recordingId}.mp3`),
    id: item.id,
    lastError: item.lastError ?? null,
    maxAttempts: item.maxAttempts,
    nextAttemptAt: new Date(item.nextAttemptAt),
    pathOverride: item.pathOverride ?? null,
    provider: item.provider,
    recordingId: item.recordingId,
    status: item.status,
    target: item.target ?? null,
    updatedAt: new Date(item.updatedAt),
    uploadPolicyId: item.uploadPolicyId ?? null,
  };
}
