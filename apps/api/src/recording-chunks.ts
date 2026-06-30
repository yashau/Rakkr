import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, createDatabase, eq, recordingChunks as recordingChunksTable } from "@rakkr/db";
import { recordingChunkSchema, type RecordingChunk } from "@rakkr/shared";

type RecordingChunkInsert = typeof recordingChunksTable.$inferInsert;
type RecordingChunkRow = typeof recordingChunksTable.$inferSelect;

interface RecordingChunkStore {
  list(): Promise<RecordingChunk[]>;
  listForJob(jobId: string): Promise<RecordingChunk[]>;
  listForRecording(recordingId: string): Promise<RecordingChunk[]>;
  upsert(chunk: RecordingChunk): Promise<void>;
}

const chunkStorePath = path.resolve(
  process.env.RAKKR_RECORDING_CHUNK_STORE_PATH ?? "data/recording-chunks.json",
);

// Deterministic id keyed on (recordingId, index) so repeated uploads for the same
// chunk index update one row (idempotent), matching the unique DB index.
export function recordingChunkId(recordingId: string, index: number) {
  return `chunk_${recordingId}_${index}`;
}

export function listRecordingChunksForRecording(recordingId: string) {
  return chunkStore.listForRecording(recordingId);
}

export function listRecordingChunksForJob(jobId: string) {
  return chunkStore.listForJob(jobId);
}

export function listRecordingChunks() {
  return chunkStore.list();
}

export async function findRecordingChunk(recordingId: string, index: number) {
  const chunks = await chunkStore.listForRecording(recordingId);

  return chunks.find((chunk) => chunk.index === index);
}

export async function upsertRecordingChunk(chunk: RecordingChunk) {
  await chunkStore.upsert(chunk);
}

// Stamp the known total on every chunk of a recording once capture stops.
export async function setRecordingChunkTotal(recordingId: string, total: number) {
  const chunks = await chunkStore.listForRecording(recordingId);

  await Promise.all(
    chunks
      .filter((chunk) => chunk.total !== total)
      .map((chunk) => chunkStore.upsert({ ...chunk, total })),
  );
}

class JsonRecordingChunkStore implements RecordingChunkStore {
  private readonly chunks: RecordingChunk[] = loadRecordingChunks();

  async list() {
    return [...this.chunks];
  }

  async listForRecording(recordingId: string) {
    return this.chunks
      .filter((chunk) => chunk.recordingId === recordingId)
      .sort((left, right) => left.index - right.index);
  }

  async listForJob(jobId: string) {
    return this.chunks
      .filter((chunk) => chunk.jobId === jobId)
      .sort((left, right) => left.index - right.index);
  }

  async upsert(chunk: RecordingChunk) {
    const index = this.chunks.findIndex((candidate) => candidate.id === chunk.id);

    if (index >= 0) {
      this.chunks[index] = chunk;
    } else {
      this.chunks.push(chunk);
    }

    this.persist();
  }

  private persist() {
    mkdirSync(path.dirname(chunkStorePath), { recursive: true });
    const tempPath = `${chunkStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        chunks: this.chunks,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, chunkStorePath);
  }
}

class PostgresRecordingChunkStore implements RecordingChunkStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: RecordingChunkStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async list() {
    if (!this.dbAvailable) {
      return this.fallback.list();
    }

    try {
      const rows = await this.db.select().from(recordingChunksTable);

      return rows.map(chunkFromRow);
    } catch (error) {
      await this.failover("recording chunk query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async listForRecording(recordingId: string) {
    if (!this.dbAvailable) {
      return this.fallback.listForRecording(recordingId);
    }

    try {
      const rows = await this.db
        .select()
        .from(recordingChunksTable)
        .where(eq(recordingChunksTable.recordingId, recordingId))
        .orderBy(asc(recordingChunksTable.index));

      return rows.map(chunkFromRow);
    } catch (error) {
      await this.failover("recording chunk lookup unavailable; using JSON store", error);
      return this.fallback.listForRecording(recordingId);
    }
  }

  async listForJob(jobId: string) {
    if (!this.dbAvailable) {
      return this.fallback.listForJob(jobId);
    }

    try {
      const rows = await this.db
        .select()
        .from(recordingChunksTable)
        .where(eq(recordingChunksTable.jobId, jobId))
        .orderBy(asc(recordingChunksTable.index));

      return rows.map(chunkFromRow);
    } catch (error) {
      await this.failover("recording chunk job lookup unavailable; using JSON store", error);
      return this.fallback.listForJob(jobId);
    }
  }

  async upsert(chunk: RecordingChunk) {
    if (!this.dbAvailable) {
      await this.fallback.upsert(chunk);
      return;
    }

    try {
      const row = chunkToRow(chunk);

      await this.db
        .insert(recordingChunksTable)
        .values(row)
        .onConflictDoUpdate({
          set: {
            cachedAt: row.cachedAt,
            cachePath: row.cachePath,
            checksum: row.checksum,
            durationSeconds: row.durationSeconds,
            enhancedCachePath: row.enhancedCachePath,
            jobId: row.jobId,
            offsetSeconds: row.offsetSeconds,
            rawCachePath: row.rawCachePath,
            sizeBytes: row.sizeBytes,
            status: row.status,
            total: row.total,
            updatedAt: new Date(),
          },
          target: recordingChunksTable.id,
        });
    } catch (error) {
      await this.failover("recording chunk persistence unavailable; using JSON store", error);
      await this.fallback.upsert(chunk);
    }
  }

  private async failover(message: string, error: unknown) {
    this.dbAvailable = false;
    console.warn(message, error);
  }
}

function createRecordingChunkStore(): RecordingChunkStore {
  const fallback = new JsonRecordingChunkStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresRecordingChunkStore(databaseUrl, fallback) : fallback;
}

const chunkStore = createRecordingChunkStore();

function loadRecordingChunks(): RecordingChunk[] {
  if (!existsSync(chunkStorePath)) {
    return [];
  }

  const raw = readFileSync(chunkStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const chunks =
    typeof parsed === "object" && parsed !== null && "chunks" in parsed
      ? (parsed as { chunks: unknown }).chunks
      : parsed;

  if (!Array.isArray(chunks)) {
    throw new Error("recording_chunk_store_invalid");
  }

  return chunks.map((chunk) => recordingChunkSchema.parse(chunk));
}

function chunkFromRow(row: RecordingChunkRow): RecordingChunk {
  return recordingChunkSchema.parse({
    cachedAt: row.cachedAt?.toISOString(),
    cachePath: row.cachePath ?? undefined,
    checksum: row.checksum ?? undefined,
    createdAt: row.createdAt.toISOString(),
    durationSeconds: row.durationSeconds,
    enhancedCachePath: row.enhancedCachePath ?? undefined,
    id: row.id,
    index: row.index,
    jobId: row.jobId,
    offsetSeconds: row.offsetSeconds,
    rawCachePath: row.rawCachePath ?? undefined,
    recordingId: row.recordingId,
    sizeBytes: row.sizeBytes ?? undefined,
    status: row.status,
    total: row.total ?? undefined,
  });
}

function chunkToRow(chunk: RecordingChunk): RecordingChunkInsert {
  return {
    cachedAt: chunk.cachedAt ? new Date(chunk.cachedAt) : null,
    cachePath: chunk.cachePath ?? null,
    checksum: chunk.checksum ?? null,
    createdAt: new Date(chunk.createdAt),
    durationSeconds: chunk.durationSeconds,
    enhancedCachePath: chunk.enhancedCachePath ?? null,
    id: chunk.id,
    index: chunk.index,
    jobId: chunk.jobId,
    offsetSeconds: chunk.offsetSeconds,
    rawCachePath: chunk.rawCachePath ?? null,
    recordingId: chunk.recordingId,
    sizeBytes: chunk.sizeBytes ?? null,
    status: chunk.status,
    total: chunk.total ?? null,
    updatedAt: new Date(),
  };
}
