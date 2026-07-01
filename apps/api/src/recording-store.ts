import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, createDatabase, desc, eq, inArray, recordings as recordingsTable } from "@rakkr/db";
import { recordingSummarySchema, type RecordingSummary } from "@rakkr/shared";
import { DatabaseUnavailableError } from "./database-unavailable.js";

type RecordingInsert = typeof recordingsTable.$inferInsert;
type RecordingRow = typeof recordingsTable.$inferSelect;

export interface RecordingStore {
  create(recording: RecordingSummary): Promise<void>;
  delete(recordingId: string): Promise<RecordingSummary | undefined>;
  find(recordingId: string): Promise<RecordingSummary | undefined>;
  list(): Promise<RecordingSummary[]>;
  save(recording: RecordingSummary): Promise<void>;
  // Atomic compare-and-set: persist `recording` only if the stored row's status
  // is still one of `allowedFrom`, returning it on a win and `undefined` when a
  // concurrent writer already moved it. Guards status-deciding writers (stop,
  // terminal, retention, reconcile) against clobbering a status another path just
  // changed — the recording-level analog of recordingJobStore.transition. Callers
  // pass their own (possibly scoped) recording object, which is what gets
  // persisted; only the STORED status gates the write.
  transition(
    recording: RecordingSummary,
    allowedFrom: RecordingSummary["status"][],
  ): Promise<RecordingSummary | undefined>;
}

const recordingStorePath = path.resolve(
  process.env.RAKKR_RECORDING_METADATA_STORE_PATH ?? "data/recordings-metadata.json",
);

export function createRecordingStore(seedRecordings: RecordingSummary[] = []): RecordingStore {
  const fallback = new JsonRecordingStore(seedRecordings);
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresRecordingStore(databaseUrl, fallback, seedRecordings) : fallback;
}

class JsonRecordingStore implements RecordingStore {
  private readonly recordings: RecordingSummary[];

  constructor(seedRecordings: RecordingSummary[]) {
    this.recordings = loadRecordings(seedRecordings);
  }

  async create(recording: RecordingSummary) {
    this.recordings.unshift(recording);
    this.persist();
  }

  async delete(recordingId: string) {
    const index = this.recordings.findIndex((recording) => recording.id === recordingId);

    if (index < 0) {
      return undefined;
    }

    const [deleted] = this.recordings.splice(index, 1);

    this.persist();

    return deleted;
  }

  async find(recordingId: string) {
    return this.recordings.find((recording) => recording.id === recordingId);
  }

  async list() {
    return this.recordings;
  }

  async save(recording: RecordingSummary) {
    const index = this.recordings.findIndex((candidate) => candidate.id === recording.id);

    if (index >= 0) {
      this.recordings[index] = recording;
    } else {
      this.recordings.unshift(recording);
    }

    this.persist();
  }

  async transition(recording: RecordingSummary, allowedFrom: RecordingSummary["status"][]) {
    // Atomic within the single-threaded event loop (no await between the read and
    // the write): a concurrent transition that already moved the recording sees
    // its new status and loses.
    const index = this.recordings.findIndex((candidate) => candidate.id === recording.id);
    const current = this.recordings[index];

    if (!current || !allowedFrom.includes(current.status)) {
      return undefined;
    }

    this.recordings[index] = recording;
    this.persist();

    return recording;
  }

  private persist() {
    mkdirSync(path.dirname(recordingStorePath), { recursive: true });
    const tempPath = `${recordingStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        recordings: this.recordings,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, recordingStorePath);
  }
}

class PostgresRecordingStore implements RecordingStore {
  private dbAvailable = true;
  private hasSeeded = false;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: RecordingStore,
    private readonly seedRecordings: RecordingSummary[],
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async create(recording: RecordingSummary) {
    if (!this.dbAvailable) {
      await this.fallback.create(recording);
      return;
    }

    try {
      await this.write(recording);
    } catch (error) {
      await this.failover("recording metadata persistence unavailable; using JSON store", error);
      await this.fallback.create(recording);
    }
  }

  async delete(recordingId: string) {
    if (!this.dbAvailable) {
      return this.fallback.delete(recordingId);
    }

    try {
      await this.seedIfEmpty();
      const existing = await this.find(recordingId);

      if (!existing) {
        return undefined;
      }

      await this.db.delete(recordingsTable).where(eq(recordingsTable.id, recordingId));

      return existing;
    } catch (error) {
      await this.failover("recording metadata delete unavailable; using JSON store", error);
      return this.fallback.delete(recordingId);
    }
  }

  async find(recordingId: string) {
    if (!this.dbAvailable) {
      return this.fallback.find(recordingId);
    }

    try {
      await this.seedIfEmpty();
      const [row] = await this.db
        .select()
        .from(recordingsTable)
        .where(eq(recordingsTable.id, recordingId))
        .limit(1);

      return row ? recordingFromRow(row) : undefined;
    } catch (error) {
      await this.failover("recording metadata lookup unavailable; using JSON store", error);
      return this.fallback.find(recordingId);
    }
  }

  async list() {
    if (!this.dbAvailable) {
      return this.fallback.list();
    }

    try {
      await this.seedIfEmpty();
      const rows = await this.db
        .select()
        .from(recordingsTable)
        // `id` is a deterministic tiebreaker so recordings sharing a recordedAt
        // (e.g. simultaneous scheduled tracks) keep a stable order across paged
        // requests — otherwise Postgres may reorder equal keys and a page
        // boundary can skip or duplicate a row.
        .orderBy(desc(recordingsTable.recordedAt), desc(recordingsTable.id));

      return rows.map(recordingFromRow);
    } catch (error) {
      await this.failover("recording metadata query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async save(recording: RecordingSummary) {
    if (!this.dbAvailable) {
      await this.fallback.save(recording);
      return;
    }

    try {
      await this.write(recording);
    } catch (error) {
      await this.failover("recording metadata update unavailable; using JSON store", error);
      await this.fallback.save(recording);
    }
  }

  async transition(recording: RecordingSummary, allowedFrom: RecordingSummary["status"][]) {
    if (!this.dbAvailable) {
      return this.fallback.transition(recording, allowedFrom);
    }

    try {
      const row = recordingToRow(recording);
      // Single atomic statement: persist only if the stored row is still in an
      // allowed source status; zero returned rows means another writer moved it.
      const [updated] = await this.db
        .update(recordingsTable)
        .set(recordingMutableColumns(row))
        .where(
          and(eq(recordingsTable.id, recording.id), inArray(recordingsTable.status, allowedFrom)),
        )
        .returning();

      return updated ? recordingFromRow(updated) : undefined;
    } catch (error) {
      await this.failover("recording metadata transition unavailable; using JSON store", error);
      return this.fallback.transition(recording, allowedFrom);
    }
  }

  private async failover(message: string, error: unknown): Promise<never> {
    // DB-authoritative store: surface unavailability as 503 instead of silently
    // diverging to the boot-time fallback. See database-unavailable.ts.
    throw new DatabaseUnavailableError(message, error);
  }

  private async seedIfEmpty() {
    if (
      this.hasSeeded ||
      this.seedRecordings.length === 0 ||
      process.env.RAKKR_SEED_DEMO_DATA === "0"
    ) {
      return;
    }

    const existing = await this.db
      .select({ id: recordingsTable.id })
      .from(recordingsTable)
      .limit(1);

    if (existing.length === 0) {
      await Promise.all(this.seedRecordings.map((recording) => this.write(recording)));
    }

    this.hasSeeded = true;
  }

  private async write(recording: RecordingSummary) {
    const row = recordingToRow(recording);

    await this.db
      .insert(recordingsTable)
      .values(row)
      .onConflictDoUpdate({
        set: recordingMutableColumns(row),
        target: recordingsTable.id,
      });
  }
}

// The mutable column set shared by the unconditional upsert (`write`) and the
// conditional compare-and-set (`transition`), so both stay in lockstep.
function recordingMutableColumns(row: RecordingInsert) {
  return {
    cachePath: row.cachePath,
    checksum: row.checksum,
    durationSeconds: row.durationSeconds,
    enhancedCachePath: row.enhancedCachePath,
    folder: row.folder,
    healthStatus: row.healthStatus,
    metadata: row.metadata,
    rawCachePath: row.rawCachePath,
    name: row.name,
    nodeId: row.nodeId,
    recordedAt: row.recordedAt,
    scheduleId: row.scheduleId,
    source: row.source,
    status: row.status,
    tags: row.tags,
  };
}

function loadRecordings(seedRecordings: RecordingSummary[]) {
  if (!existsSync(recordingStorePath)) {
    return seedRecordings.map((recording) => ({ ...recording }));
  }

  const raw = readFileSync(recordingStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const recordings = isRecordingStore(parsed) ? parsed.recordings : parsed;

  if (!Array.isArray(recordings)) {
    throw new Error("recording_metadata_store_invalid");
  }

  return recordings.filter(isRecordingSummary);
}

function recordingToRow(recording: RecordingSummary): RecordingInsert {
  return {
    cachePath: recording.cachePath ?? null,
    checksum: recording.checksum ?? null,
    durationSeconds: recording.durationSeconds,
    enhancedCachePath: recording.enhancedCachePath ?? null,
    folder: recording.folder,
    rawCachePath: recording.rawCachePath ?? null,
    healthStatus: recording.healthStatus,
    id: recording.id,
    name: recording.name,
    nodeId: recording.nodeId ?? null,
    recordedAt: new Date(recording.recordedAt),
    scheduleId: recording.scheduleId ?? null,
    source: recording.source,
    status: recording.status,
    tags: recording.tags,
    metadata: recordingMetadata(recording),
  };
}

function recordingFromRow(row: RecordingRow): RecordingSummary {
  const metadata = record(row.metadata);

  return {
    cached: cachedFromRow(row),
    cachePath: row.cachePath ?? undefined,
    checksum: row.checksum ?? undefined,
    durationSeconds: row.durationSeconds,
    enhancedCachePath: row.enhancedCachePath ?? undefined,
    folder: row.folder,
    healthStatus: healthStatus(row.healthStatus),
    rawCachePath: row.rawCachePath ?? undefined,
    id: row.id,
    name: row.name,
    nodeId: row.nodeId ?? undefined,
    notes: stringOrUndefined(metadata?.notes),
    recordedAt: row.recordedAt.toISOString(),
    recordingProfileId: stringOrUndefined(metadata?.recordingProfileId),
    retentionPolicyId: stringOrUndefined(metadata?.retentionPolicyId),
    scheduleId: row.scheduleId ?? undefined,
    source: row.source,
    status: row.status,
    tags: stringArray(row.tags),
    transcriptSnippets: transcriptSnippetsOrUndefined(metadata?.transcriptSnippets),
    trackGroupId: stringOrUndefined(metadata?.trackGroupId),
    trackIndex: positiveIntegerOrUndefined(metadata?.trackIndex),
    trackTotal: positiveIntegerOrUndefined(metadata?.trackTotal),
    uploadPolicyIds: uploadPolicyIdsFromMetadata(metadata),
    watchdogPolicyId: stringOrUndefined(metadata?.watchdogPolicyId),
    waveformPreview: waveformPreviewOrUndefined(metadata?.waveformPreview),
  };
}

function recordingMetadata(recording: RecordingSummary) {
  return {
    cached: recording.cached,
    notes: recording.notes,
    recordingProfileId: recording.recordingProfileId,
    retentionPolicyId: recording.retentionPolicyId,
    transcriptSnippets: recording.transcriptSnippets,
    trackGroupId: recording.trackGroupId,
    trackIndex: recording.trackIndex,
    trackTotal: recording.trackTotal,
    uploadPolicyIds: recording.uploadPolicyIds,
    watchdogPolicyId: recording.watchdogPolicyId,
    waveformPreview: recording.waveformPreview,
  };
}

function waveformPreviewOrUndefined(value: unknown) {
  const result = recordingSummarySchema.shape.waveformPreview.safeParse(value);

  return result.success ? result.data : undefined;
}

function transcriptSnippetsOrUndefined(value: unknown) {
  const result = recordingSummarySchema.shape.transcriptSnippets.safeParse(value);

  return result.success ? result.data : undefined;
}

function cachedFromRow(row: RecordingRow) {
  return (
    Boolean(row.cachePath) ||
    row.status === "cached" ||
    row.status === "uploaded" ||
    record(row.metadata)?.cached === true
  );
}

function healthStatus(value: string): RecordingSummary["healthStatus"] {
  if (value === "healthy" || value === "warning" || value === "critical" || value === "unknown") {
    return value;
  }

  return "unknown";
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// Reads the recording's upload policy ids from metadata, falling back to the
// legacy singular `uploadPolicyId` for rows written before the multi-policy change.
function uploadPolicyIdsFromMetadata(metadata: Record<string, unknown> | undefined) {
  const ids = metadata?.uploadPolicyIds;

  if (Array.isArray(ids)) {
    const strings = stringArray(ids);

    return strings.length > 0 ? strings : undefined;
  }

  const legacy = stringOrUndefined(metadata?.uploadPolicyId);

  return legacy ? [legacy] : undefined;
}

function optionalStringArray(value: unknown) {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function positiveIntegerOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecordingStore(value: unknown): value is { recordings: unknown[] } {
  return isRecord(value) && Array.isArray(value.recordings);
}

function isRecordingSummary(value: unknown): value is RecordingSummary {
  if (!isRecord(value) || !Array.isArray(value.tags)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.folder === "string" &&
    typeof value.recordedAt === "string" &&
    typeof value.durationSeconds === "number" &&
    typeof value.cached === "boolean" &&
    optionalString(value.recordingProfileId) &&
    optionalString(value.retentionPolicyId) &&
    optionalStringArray(value.uploadPolicyIds) &&
    optionalString(value.watchdogPolicyId) &&
    healthStatus(value.healthStatus as string) === value.healthStatus &&
    (value.source === "ad_hoc" || value.source === "schedule") &&
    (value.status === "queued" ||
      value.status === "recording" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "cached" ||
      value.status === "uploaded" ||
      value.status === "partial") &&
    stringArray(value.tags).length === value.tags.length
  );
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
