import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, desc, eq, schedules as schedulesTable } from "@rakkr/db";
import {
  defaultKeepControllerCacheRetentionPolicy,
  defaultScheduledVoiceWatchdogPolicy,
  defaultStubUploadPolicy,
  defaultVoiceRecordingProfile,
  scheduleRecurrenceSchema,
  scheduleSummarySchema,
  type ScheduleRecurrence,
  type ScheduleSummary,
} from "@rakkr/shared";

type ScheduleInsert = typeof schedulesTable.$inferInsert;
type ScheduleRow = typeof schedulesTable.$inferSelect;
type ScheduleUpdate = Partial<Omit<ScheduleSummary, "id">>;

export class ScheduleStoreError extends Error {
  constructor(
    message: string,
    readonly code: "schedule_exists",
  ) {
    super(message);
  }
}

export interface ScheduleStore {
  create(schedule: ScheduleSummary): Promise<ScheduleSummary>;
  delete(scheduleId: string): Promise<ScheduleSummary | undefined>;
  find(scheduleId: string): Promise<ScheduleSummary | undefined>;
  list(): Promise<ScheduleSummary[]>;
  update(scheduleId: string, updates: ScheduleUpdate): Promise<ScheduleSummary | undefined>;
}

const scheduleStorePath = path.resolve(
  process.env.RAKKR_SCHEDULE_STORE_PATH ?? "data/schedules.json",
);

export function createScheduleStore(seedSchedules: ScheduleSummary[] = []): ScheduleStore {
  const fallback = new JsonScheduleStore(seedSchedules);
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresScheduleStore(databaseUrl, fallback, seedSchedules) : fallback;
}

class JsonScheduleStore implements ScheduleStore {
  private readonly schedules: ScheduleSummary[];

  constructor(seedSchedules: ScheduleSummary[]) {
    this.schedules = loadSchedules(seedSchedules);
  }

  async create(schedule: ScheduleSummary) {
    if (this.schedules.some((candidate) => candidate.id === schedule.id)) {
      throw new ScheduleStoreError("Schedule already exists", "schedule_exists");
    }

    this.schedules.unshift(cloneSchedule(schedule));
    this.persist();

    return schedule;
  }

  async delete(scheduleId: string) {
    const index = this.schedules.findIndex((schedule) => schedule.id === scheduleId);

    if (index < 0) {
      return undefined;
    }

    const [deleted] = this.schedules.splice(index, 1);
    this.persist();

    return deleted;
  }

  async find(scheduleId: string) {
    return this.schedules.find((schedule) => schedule.id === scheduleId);
  }

  async list() {
    return this.schedules;
  }

  async update(scheduleId: string, updates: ScheduleUpdate) {
    const index = this.schedules.findIndex((schedule) => schedule.id === scheduleId);

    if (index < 0) {
      return undefined;
    }

    const updated = { ...this.schedules[index], ...updates, id: scheduleId };
    this.schedules[index] = updated;
    this.persist();

    return updated;
  }

  private persist() {
    mkdirSync(path.dirname(scheduleStorePath), { recursive: true });
    const tempPath = `${scheduleStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        schedules: this.schedules,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, scheduleStorePath);
  }
}

class PostgresScheduleStore implements ScheduleStore {
  private dbAvailable = true;
  private hasSeeded = false;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: ScheduleStore,
    private readonly seedSchedules: ScheduleSummary[],
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async create(schedule: ScheduleSummary) {
    if (!this.dbAvailable) {
      return this.fallback.create(schedule);
    }

    try {
      await this.seedIfEmpty();
      const existing = await this.findRow(schedule.id);

      if (existing) {
        throw new ScheduleStoreError("Schedule already exists", "schedule_exists");
      }

      await this.write(schedule);

      return schedule;
    } catch (error) {
      if (error instanceof ScheduleStoreError) {
        throw error;
      }

      await this.failover("schedule persistence unavailable; using JSON store", error);
      return this.fallback.create(schedule);
    }
  }

  async delete(scheduleId: string) {
    if (!this.dbAvailable) {
      return this.fallback.delete(scheduleId);
    }

    try {
      await this.seedIfEmpty();
      const existing = await this.findRow(scheduleId);

      if (!existing) {
        return undefined;
      }

      await this.db.delete(schedulesTable).where(eq(schedulesTable.id, scheduleId));

      return scheduleFromRow(existing);
    } catch (error) {
      await this.failover("schedule delete unavailable; using JSON store", error);
      return this.fallback.delete(scheduleId);
    }
  }

  async find(scheduleId: string) {
    if (!this.dbAvailable) {
      return this.fallback.find(scheduleId);
    }

    try {
      await this.seedIfEmpty();
      const row = await this.findRow(scheduleId);

      return row ? scheduleFromRow(row) : undefined;
    } catch (error) {
      await this.failover("schedule lookup unavailable; using JSON store", error);
      return this.fallback.find(scheduleId);
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
        .from(schedulesTable)
        .orderBy(desc(schedulesTable.createdAt));

      return rows.map(scheduleFromRow);
    } catch (error) {
      await this.failover("schedule query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async update(scheduleId: string, updates: ScheduleUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(scheduleId, updates);
    }

    try {
      await this.seedIfEmpty();
      const existing = await this.findRow(scheduleId);

      if (!existing) {
        return undefined;
      }

      const updated = { ...scheduleFromRow(existing), ...updates, id: scheduleId };
      await this.write(updated);

      return updated;
    } catch (error) {
      await this.failover("schedule update unavailable; using JSON store", error);
      return this.fallback.update(scheduleId, updates);
    }
  }

  private async failover(message: string, error: unknown) {
    this.dbAvailable = false;
    console.warn(message, error);
  }

  private async findRow(scheduleId: string) {
    const [row] = await this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.id, scheduleId))
      .limit(1);

    return row;
  }

  private async seedIfEmpty() {
    if (
      this.hasSeeded ||
      this.seedSchedules.length === 0 ||
      process.env.RAKKR_SEED_DEMO_DATA === "0"
    ) {
      return;
    }

    const existing = await this.db.select({ id: schedulesTable.id }).from(schedulesTable).limit(1);

    if (existing.length === 0) {
      await Promise.all(this.seedSchedules.map((schedule) => this.write(schedule)));
    }

    this.hasSeeded = true;
  }

  private async write(schedule: ScheduleSummary) {
    const row = scheduleToRow(schedule);

    await this.db
      .insert(schedulesTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
          enabled: row.enabled,
          folderTemplate: row.folderTemplate,
          name: row.name,
          nextRunAt: row.nextRunAt,
          nodeId: row.nodeId,
          recurrence: row.recurrence,
          recordingProfileId: row.recordingProfileId,
          retentionPolicyId: row.retentionPolicyId,
          room: row.room,
          tags: row.tags,
          timezone: row.timezone,
          titleTemplate: row.titleTemplate,
          uploadPolicyId: row.uploadPolicyId,
          watchdogPolicyId: row.watchdogPolicyId,
        },
        target: schedulesTable.id,
      });
  }
}

function loadSchedules(seedSchedules: ScheduleSummary[]) {
  if (!existsSync(scheduleStorePath)) {
    return seedSchedules.map(cloneSchedule);
  }

  const raw = readFileSync(scheduleStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const schedules = isScheduleStore(parsed) ? parsed.schedules : parsed;

  if (!Array.isArray(schedules)) {
    throw new Error("schedule_store_invalid");
  }

  return schedules
    .map(normalizeSchedule)
    .filter((schedule): schedule is ScheduleSummary => schedule !== undefined);
}

function scheduleToRow(schedule: ScheduleSummary): ScheduleInsert {
  return {
    enabled: schedule.enabled,
    folderTemplate: schedule.folderTemplate,
    id: schedule.id,
    name: schedule.name,
    nextRunAt: dateOrNull(schedule.nextRunAt),
    nodeId: schedule.nodeId,
    recurrence: scheduleRecurrence(schedule),
    recordingProfileId: schedule.recordingProfileId,
    retentionPolicyId: schedule.retentionPolicyId,
    room: schedule.room,
    tags: schedule.tags,
    timezone: schedule.timezone,
    titleTemplate: schedule.titleTemplate,
    uploadPolicyId: schedule.uploadPolicyId,
    watchdogPolicyId: schedule.watchdogPolicyId,
  };
}

function scheduleFromRow(row: ScheduleRow): ScheduleSummary {
  const recurrence = recurrenceFromValue(row.recurrence);

  return {
    enabled: row.enabled,
    folderTemplate: row.folderTemplate,
    id: row.id,
    name: row.name,
    nextRunAt: isoOrUndefined(row.nextRunAt),
    nodeId: row.nodeId ?? "unassigned",
    recurrence,
    recordingProfileId: row.recordingProfileId ?? defaultVoiceRecordingProfile.id,
    retentionPolicyId: row.retentionPolicyId ?? defaultKeepControllerCacheRetentionPolicy.id,
    room: row.room,
    tags: stringArray(row.tags),
    timezone: row.timezone,
    titleTemplate: row.titleTemplate,
    uploadPolicyId: row.uploadPolicyId ?? defaultStubUploadPolicy.id,
    watchdogPolicyId: row.watchdogPolicyId ?? defaultScheduledVoiceWatchdogPolicy.id,
  };
}

function scheduleRecurrence(schedule: ScheduleSummary) {
  return schedule.recurrence;
}

function cloneSchedule(schedule: ScheduleSummary) {
  return {
    ...schedule,
    recurrence: { ...schedule.recurrence },
    tags: [...schedule.tags],
  };
}

function normalizeSchedule(value: unknown) {
  const parsed = scheduleSummarySchema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const migrated = {
    ...value,
    recurrence: recurrenceFromValue(value.recurrence, stringOrUndefined(value.nextRunAt)),
  };
  const migratedParsed = scheduleSummarySchema.safeParse(migrated);

  return migratedParsed.success ? migratedParsed.data : undefined;
}

function recurrenceFromValue(value: unknown, nextRunAt?: string): ScheduleRecurrence {
  const parsed = scheduleRecurrenceSchema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  if (isRecord(value) && value.mode === "manual") {
    return { mode: "manual" };
  }

  if (nextRunAt) {
    return { mode: "once", startsAt: nextRunAt };
  }

  return { mode: "manual" };
}

function dateOrNull(value: string | undefined) {
  return value ? new Date(value) : null;
}

function isoOrUndefined(value: Date | null) {
  return value?.toISOString();
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isScheduleStore(value: unknown): value is { schedules: unknown[] } {
  return record(value) !== undefined && Array.isArray(record(value)?.schedules);
}
