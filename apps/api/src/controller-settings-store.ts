import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { controllerSettings as controllerSettingsTable, createDatabase, eq, sql } from "@rakkr/db";
import { DatabaseUnavailableError } from "./database-unavailable.js";
import {
  controllerSettingsSchema,
  defaultControllerSettings,
  type ControllerSettings,
  type ControllerSettingsUpdate,
} from "@rakkr/shared";

export interface ControllerSettingsStore {
  find(): Promise<ControllerSettings>;
  update(update: ControllerSettingsUpdate): Promise<ControllerSettings>;
}

const controllerSettingsId = "controller";
const controllerSettingsStorePath = path.resolve(
  process.env.RAKKR_CONTROLLER_SETTINGS_STORE_PATH ?? "data/controller-settings.json",
);

export function createControllerSettingsStore(): ControllerSettingsStore {
  const fallback = new JsonControllerSettingsStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresControllerSettingsStore(databaseUrl, fallback) : fallback;
}

class JsonControllerSettingsStore implements ControllerSettingsStore {
  private settings: ControllerSettings = loadControllerSettings();

  async find() {
    return this.settings;
  }

  async update(update: ControllerSettingsUpdate) {
    this.settings = mergeControllerSettings(this.settings, update);
    persistControllerSettings(this.settings);

    return this.settings;
  }
}

class PostgresControllerSettingsStore implements ControllerSettingsStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: ControllerSettingsStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async find() {
    if (!this.dbAvailable) {
      return this.fallback.find();
    }

    try {
      const [row] = await this.db
        .select()
        .from(controllerSettingsTable)
        .where(eq(controllerSettingsTable.id, controllerSettingsId))
        .limit(1);

      return row
        ? controllerSettingsSchema.parse(settingsFromRow(row))
        : { ...defaultControllerSettings };
    } catch (error) {
      this.failover("controller settings lookup unavailable; using JSON store", error);
      return this.fallback.find();
    }
  }

  async update(update: ControllerSettingsUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(update);
    }

    try {
      // Serialize concurrent updates of the singleton controller-settings row so a
      // read-merge-write does not clobber another operator's field. An advisory
      // lock serializes even before the row's first insert — a plain SELECT FOR
      // UPDATE would lock nothing while the row does not yet exist.
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('controller-settings'))`);

        const [row] = await tx
          .select()
          .from(controllerSettingsTable)
          .where(eq(controllerSettingsTable.id, controllerSettingsId))
          .limit(1);
        const current = row
          ? controllerSettingsSchema.parse(settingsFromRow(row))
          : { ...defaultControllerSettings };
        const merged = mergeControllerSettings(current, update);

        await tx
          .insert(controllerSettingsTable)
          .values({ ...settingsToRow(merged), id: controllerSettingsId, updatedAt: new Date() })
          .onConflictDoUpdate({
            set: { ...settingsToRow(merged), updatedAt: new Date() },
            target: controllerSettingsTable.id,
          });

        return merged;
      });
    } catch (error) {
      this.failover("controller settings update unavailable; using JSON store", error);
      return this.fallback.update(update);
    }
  }

  private failover(message: string, error: unknown): never {
    throw new DatabaseUnavailableError(message, error);
  }
}

function mergeControllerSettings(
  current: ControllerSettings,
  update: ControllerSettingsUpdate,
): ControllerSettings {
  // `keep` distinguishes an omitted field (keep current) from an explicit
  // `null` (clear the default) — a plain `??` would treat a clearing `null` as
  // "use current" and make defaults impossible to unset.
  const keep = <T>(next: T | undefined, previous: T): T => (next === undefined ? previous : next);

  return controllerSettingsSchema.parse({
    controllerName: update.controllerName ?? current.controllerName,
    defaultRecordingProfileId: keep(
      update.defaultRecordingProfileId,
      current.defaultRecordingProfileId,
    ),
    defaultRetentionPolicyId: keep(
      update.defaultRetentionPolicyId,
      current.defaultRetentionPolicyId,
    ),
    defaultUploadPolicyId: keep(update.defaultUploadPolicyId, current.defaultUploadPolicyId),
    defaultWatchdogPolicyId: keep(update.defaultWatchdogPolicyId, current.defaultWatchdogPolicyId),
    weekStartsOn: update.weekStartsOn ?? current.weekStartsOn,
  });
}

type ControllerSettingsRow = typeof controllerSettingsTable.$inferSelect;

function settingsFromRow(row: ControllerSettingsRow) {
  return {
    controllerName: row.controllerName,
    defaultRecordingProfileId: row.defaultRecordingProfileId,
    defaultRetentionPolicyId: row.defaultRetentionPolicyId,
    defaultUploadPolicyId: row.defaultUploadPolicyId,
    defaultWatchdogPolicyId: row.defaultWatchdogPolicyId,
    weekStartsOn: row.weekStartsOn,
  };
}

function settingsToRow(settings: ControllerSettings) {
  return {
    controllerName: settings.controllerName,
    defaultRecordingProfileId: settings.defaultRecordingProfileId,
    defaultRetentionPolicyId: settings.defaultRetentionPolicyId,
    defaultUploadPolicyId: settings.defaultUploadPolicyId,
    defaultWatchdogPolicyId: settings.defaultWatchdogPolicyId,
    weekStartsOn: settings.weekStartsOn,
  };
}

function loadControllerSettings(): ControllerSettings {
  if (!existsSync(controllerSettingsStorePath)) {
    return { ...defaultControllerSettings };
  }

  const raw = readFileSync(controllerSettingsStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const value =
    typeof parsed === "object" && parsed !== null && "controller" in parsed
      ? (parsed as { controller: unknown }).controller
      : parsed;

  return controllerSettingsSchema.parse(value);
}

function persistControllerSettings(value: ControllerSettings) {
  mkdirSync(path.dirname(controllerSettingsStorePath), { recursive: true });
  const tempPath = `${controllerSettingsStorePath}.${process.pid}.tmp`;
  const payload = JSON.stringify(
    { controller: value, updatedAt: new Date().toISOString(), version: 1 },
    null,
    2,
  );

  writeFileSync(tempPath, `${payload}\n`);
  renameSync(tempPath, controllerSettingsStorePath);
}
