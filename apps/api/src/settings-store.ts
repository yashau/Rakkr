import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, desc, eq, recordingProfiles as recordingProfilesTable } from "@rakkr/db";
import {
  defaultVoiceRecordingProfile,
  recordingProfileSchema,
  type RecordingProfile,
  type RecordingProfileUpdate,
} from "@rakkr/shared";

type RecordingProfileInsert = typeof recordingProfilesTable.$inferInsert;
type RecordingProfileRow = typeof recordingProfilesTable.$inferSelect;

export interface SettingsStore {
  findRecordingProfile(profileId: string): Promise<RecordingProfile | undefined>;
  listRecordingProfiles(): Promise<RecordingProfile[]>;
  updateRecordingProfile(
    profileId: string,
    update: RecordingProfileUpdate,
  ): Promise<RecordingProfile | undefined>;
}

const recordingProfileStorePath = path.resolve(
  process.env.RAKKR_RECORDING_PROFILE_STORE_PATH ?? "data/recording-profiles.json",
);

export function createSettingsStore(
  seedProfiles: RecordingProfile[] = [defaultVoiceRecordingProfile],
) {
  const fallback = new JsonSettingsStore(seedProfiles);
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresSettingsStore(databaseUrl, fallback, seedProfiles) : fallback;
}

class JsonSettingsStore implements SettingsStore {
  private readonly profiles: RecordingProfile[];

  constructor(seedProfiles: RecordingProfile[]) {
    this.profiles = loadRecordingProfiles(seedProfiles);
  }

  async findRecordingProfile(profileId: string) {
    return this.profiles.find((profile) => profile.id === profileId);
  }

  async listRecordingProfiles() {
    return this.profiles;
  }

  async updateRecordingProfile(profileId: string, update: RecordingProfileUpdate) {
    const index = this.profiles.findIndex((profile) => profile.id === profileId);

    if (index < 0) {
      return undefined;
    }

    const updated = { ...this.profiles[index], ...update, id: profileId };
    this.profiles[index] = updated;
    this.persist();

    return updated;
  }

  private persist() {
    mkdirSync(path.dirname(recordingProfileStorePath), { recursive: true });
    const tempPath = `${recordingProfileStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        profiles: this.profiles,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, recordingProfileStorePath);
  }
}

class PostgresSettingsStore implements SettingsStore {
  private dbAvailable = true;
  private hasSeeded = false;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: SettingsStore,
    private readonly seedProfiles: RecordingProfile[],
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async findRecordingProfile(profileId: string) {
    if (!this.dbAvailable) {
      return this.fallback.findRecordingProfile(profileId);
    }

    try {
      await this.seedIfEmpty();
      const [row] = await this.db
        .select()
        .from(recordingProfilesTable)
        .where(eq(recordingProfilesTable.id, profileId))
        .limit(1);

      return row ? recordingProfileFromRow(row) : undefined;
    } catch (error) {
      await this.failover("recording profile lookup unavailable; using JSON store", error);
      return this.fallback.findRecordingProfile(profileId);
    }
  }

  async listRecordingProfiles() {
    if (!this.dbAvailable) {
      return this.fallback.listRecordingProfiles();
    }

    try {
      await this.seedIfEmpty();
      const rows = await this.db
        .select()
        .from(recordingProfilesTable)
        .orderBy(desc(recordingProfilesTable.createdAt));

      return rows.map(recordingProfileFromRow);
    } catch (error) {
      await this.failover("recording profile query unavailable; using JSON store", error);
      return this.fallback.listRecordingProfiles();
    }
  }

  async updateRecordingProfile(profileId: string, update: RecordingProfileUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.updateRecordingProfile(profileId, update);
    }

    try {
      await this.seedIfEmpty();
      const existing = await this.findRecordingProfile(profileId);

      if (!existing) {
        return undefined;
      }

      const updated = { ...existing, ...update, id: profileId };
      await this.write(updated);

      return updated;
    } catch (error) {
      await this.failover("recording profile update unavailable; using JSON store", error);
      return this.fallback.updateRecordingProfile(profileId, update);
    }
  }

  private async seedIfEmpty() {
    if (
      this.hasSeeded ||
      this.seedProfiles.length === 0 ||
      process.env.RAKKR_SEED_DEMO_DATA === "0"
    ) {
      return;
    }

    const existing = await this.db
      .select({ id: recordingProfilesTable.id })
      .from(recordingProfilesTable)
      .limit(1);

    if (existing.length === 0) {
      await Promise.all(this.seedProfiles.map((profile) => this.write(profile)));
    }

    this.hasSeeded = true;
  }

  private async write(profile: RecordingProfile) {
    const row = recordingProfileToRow(profile);

    await this.db
      .insert(recordingProfilesTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
          bitrateKbps: row.bitrateKbps,
          channelMode: row.channelMode,
          codec: row.codec,
          name: row.name,
          settings: row.settings,
          silenceDetectionEnabled: row.silenceDetectionEnabled,
          silenceSkipEnabled: row.silenceSkipEnabled,
          vbr: row.vbr,
        },
        target: recordingProfilesTable.id,
      });
  }

  private async failover(message: string, error: unknown) {
    this.dbAvailable = false;
    console.warn(message, error);
  }
}

function loadRecordingProfiles(seedProfiles: RecordingProfile[]) {
  if (!existsSync(recordingProfileStorePath)) {
    return seedProfiles.map((profile) => ({ ...profile }));
  }

  const raw = readFileSync(recordingProfileStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const profiles = isRecordingProfileStore(parsed) ? parsed.profiles : parsed;

  if (!Array.isArray(profiles)) {
    throw new Error("recording_profile_store_invalid");
  }

  return profiles.map((profile) => recordingProfileSchema.parse(profile));
}

function recordingProfileToRow(profile: RecordingProfile): RecordingProfileInsert {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    codec: profile.codec,
    id: profile.id,
    name: profile.name,
    settings: {},
    silenceDetectionEnabled: profile.silenceDetectionEnabled,
    silenceSkipEnabled: profile.silenceSkipEnabled,
    vbr: profile.vbr,
  };
}

function recordingProfileFromRow(row: RecordingProfileRow): RecordingProfile {
  return recordingProfileSchema.parse({
    bitrateKbps: row.bitrateKbps,
    channelMode: row.channelMode,
    codec: row.codec,
    id: row.id,
    name: row.name,
    silenceDetectionEnabled: row.silenceDetectionEnabled,
    silenceSkipEnabled: row.silenceSkipEnabled,
    vbr: row.vbr,
  });
}

function isRecordingProfileStore(value: unknown): value is { profiles: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { profiles?: unknown }).profiles)
  );
}
