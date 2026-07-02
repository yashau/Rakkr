import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, createDatabase, eq, inArray, or, roomRoster as roomRosterTable } from "@rakkr/db";
import { type RoomCapability, type RoomRosterEntry, roomCapabilitySchema } from "@rakkr/shared";
import { DatabaseUnavailableError } from "./database-unavailable.js";

type RoomRosterInsert = typeof roomRosterTable.$inferInsert;
type RoomRosterRow = typeof roomRosterTable.$inferSelect;

type SubjectType = "user" | "group";

type ManualEntry = {
  capabilities: RoomCapability[];
  subjectId: string;
  subjectType: SubjectType;
};

type CalendarReconcileInput = {
  capabilities: RoomCapability[];
  roomId: string | undefined;
  scheduleId: string;
  subjects: Array<{ subjectId: string; subjectType: SubjectType }>;
};

type RosterSubject = {
  groupIds: string[];
  userId: string;
};

export interface RoomRosterStore {
  effectiveCapabilities(subject: RosterSubject, roomId: string): Promise<Set<RoomCapability>>;
  listForRoom(roomId: string): Promise<RoomRosterEntry[]>;
  reconcileCalendar(input: CalendarReconcileInput): Promise<void>;
  removeForSchedule(scheduleId: string): Promise<void>;
  replaceManual(roomId: string, entries: ManualEntry[], grantedByUserId?: string): Promise<void>;
  roomsForSubject(subject: RosterSubject): Promise<Map<string, Set<RoomCapability>>>;
}

// Internal roster row shape used by the JSON fallback store and shared mapping
// helpers. Mirrors the DB columns the store actually reads/writes.
type RosterRecord = {
  capabilities: RoomCapability[];
  grantedByUserId: string | null;
  roomId: string;
  source: "manual" | "calendar";
  sourceScheduleId: string | null;
  subjectId: string;
  subjectType: SubjectType;
};

const roomRosterStorePath = path.resolve(
  process.env.RAKKR_ROOM_ROSTER_STORE_PATH ?? "data/room-roster.json",
);

export function createRoomRosterStore(): RoomRosterStore {
  const fallback = new JsonRoomRosterStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresRoomRosterStore(databaseUrl, fallback) : fallback;
}

class JsonRoomRosterStore implements RoomRosterStore {
  private readonly rows: RosterRecord[];

  constructor() {
    this.rows = loadRoster();
  }

  async effectiveCapabilities(subject: RosterSubject, roomId: string) {
    const capabilities = new Set<RoomCapability>();

    for (const row of this.rows) {
      if (row.roomId === roomId && subjectMatches(row, subject)) {
        for (const capability of row.capabilities) {
          capabilities.add(capability);
        }
      }
    }

    return capabilities;
  }

  async listForRoom(roomId: string) {
    return this.rows.filter((row) => row.roomId === roomId).map(rosterEntryFromRecord);
  }

  async reconcileCalendar(input: CalendarReconcileInput) {
    this.removeWhere(
      (row) => row.source === "calendar" && row.sourceScheduleId === input.scheduleId,
    );

    const capabilities = sanitizeCapabilities(input.capabilities);

    if (!input.roomId || input.subjects.length === 0 || capabilities.length === 0) {
      this.persist();
      return;
    }

    for (const subject of input.subjects) {
      this.rows.push({
        capabilities,
        grantedByUserId: null,
        roomId: input.roomId,
        source: "calendar",
        sourceScheduleId: input.scheduleId,
        subjectId: subject.subjectId,
        subjectType: subject.subjectType,
      });
    }

    this.persist();
  }

  async removeForSchedule(scheduleId: string) {
    this.removeWhere((row) => row.sourceScheduleId === scheduleId);
    this.persist();
  }

  async replaceManual(roomId: string, entries: ManualEntry[], grantedByUserId?: string) {
    this.removeWhere((row) => row.roomId === roomId && row.source === "manual");

    for (const entry of entries) {
      const capabilities = sanitizeCapabilities(entry.capabilities);

      if (capabilities.length === 0) {
        continue;
      }

      this.rows.push({
        capabilities,
        grantedByUserId: grantedByUserId ?? null,
        roomId,
        source: "manual",
        sourceScheduleId: null,
        subjectId: entry.subjectId,
        subjectType: entry.subjectType,
      });
    }

    this.persist();
  }

  async roomsForSubject(subject: RosterSubject) {
    const rooms = new Map<string, Set<RoomCapability>>();

    for (const row of this.rows) {
      if (!subjectMatches(row, subject)) {
        continue;
      }

      const capabilities = rooms.get(row.roomId) ?? new Set<RoomCapability>();

      for (const capability of row.capabilities) {
        capabilities.add(capability);
      }

      rooms.set(row.roomId, capabilities);
    }

    return rooms;
  }

  private removeWhere(predicate: (row: RosterRecord) => boolean) {
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (predicate(this.rows[index])) {
        this.rows.splice(index, 1);
      }
    }
  }

  private persist() {
    mkdirSync(path.dirname(roomRosterStorePath), { recursive: true });
    const tempPath = `${roomRosterStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        roster: this.rows,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, roomRosterStorePath);
  }
}

class PostgresRoomRosterStore implements RoomRosterStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: RoomRosterStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async effectiveCapabilities(subject: RosterSubject, roomId: string) {
    if (!this.dbAvailable) {
      return this.fallback.effectiveCapabilities(subject, roomId);
    }

    try {
      const rows = await this.db
        .select()
        .from(roomRosterTable)
        .where(eq(roomRosterTable.roomId, roomId));

      const capabilities = new Set<RoomCapability>();

      for (const row of rows) {
        if (subjectMatches(rosterRecordFromRow(row), subject)) {
          for (const capability of capabilitiesFromValue(row.capabilities)) {
            capabilities.add(capability);
          }
        }
      }

      return capabilities;
    } catch (error) {
      await this.failover("room roster lookup unavailable; using JSON store", error);
      return this.fallback.effectiveCapabilities(subject, roomId);
    }
  }

  async listForRoom(roomId: string) {
    if (!this.dbAvailable) {
      return this.fallback.listForRoom(roomId);
    }

    try {
      const rows = await this.db
        .select()
        .from(roomRosterTable)
        .where(eq(roomRosterTable.roomId, roomId));

      return rows.map((row) => rosterEntryFromRecord(rosterRecordFromRow(row)));
    } catch (error) {
      await this.failover("room roster query unavailable; using JSON store", error);
      return this.fallback.listForRoom(roomId);
    }
  }

  async reconcileCalendar(input: CalendarReconcileInput) {
    if (!this.dbAvailable) {
      return this.fallback.reconcileCalendar(input);
    }

    try {
      await this.db
        .delete(roomRosterTable)
        .where(
          and(
            eq(roomRosterTable.source, "calendar"),
            eq(roomRosterTable.sourceScheduleId, input.scheduleId),
          ),
        );

      const capabilities = sanitizeCapabilities(input.capabilities);

      if (!input.roomId || input.subjects.length === 0 || capabilities.length === 0) {
        return;
      }

      const roomId = input.roomId;
      const values: RoomRosterInsert[] = input.subjects.map((subject) => ({
        capabilities,
        roomId,
        source: "calendar",
        sourceScheduleId: input.scheduleId,
        subjectId: subject.subjectId,
        subjectType: subject.subjectType,
      }));

      await this.db.insert(roomRosterTable).values(values);
    } catch (error) {
      await this.failover("room roster reconcile unavailable; using JSON store", error);
      return this.fallback.reconcileCalendar(input);
    }
  }

  async removeForSchedule(scheduleId: string) {
    if (!this.dbAvailable) {
      return this.fallback.removeForSchedule(scheduleId);
    }

    try {
      await this.db.delete(roomRosterTable).where(eq(roomRosterTable.sourceScheduleId, scheduleId));
    } catch (error) {
      await this.failover("room roster schedule removal unavailable; using JSON store", error);
      return this.fallback.removeForSchedule(scheduleId);
    }
  }

  async replaceManual(roomId: string, entries: ManualEntry[], grantedByUserId?: string) {
    if (!this.dbAvailable) {
      return this.fallback.replaceManual(roomId, entries, grantedByUserId);
    }

    try {
      await this.db
        .delete(roomRosterTable)
        .where(and(eq(roomRosterTable.roomId, roomId), eq(roomRosterTable.source, "manual")));

      const values: RoomRosterInsert[] = [];

      for (const entry of entries) {
        const capabilities = sanitizeCapabilities(entry.capabilities);

        if (capabilities.length === 0) {
          continue;
        }

        values.push({
          capabilities,
          grantedByUserId: grantedByUserId ?? null,
          roomId,
          source: "manual",
          sourceScheduleId: null,
          subjectId: entry.subjectId,
          subjectType: entry.subjectType,
        });
      }

      if (values.length > 0) {
        await this.db.insert(roomRosterTable).values(values);
      }
    } catch (error) {
      await this.failover("room roster manual replace unavailable; using JSON store", error);
      return this.fallback.replaceManual(roomId, entries, grantedByUserId);
    }
  }

  async roomsForSubject(subject: RosterSubject) {
    if (!this.dbAvailable) {
      return this.fallback.roomsForSubject(subject);
    }

    try {
      const userMatch = and(
        eq(roomRosterTable.subjectType, "user"),
        eq(roomRosterTable.subjectId, subject.userId),
      );
      const groupMatch =
        subject.groupIds.length > 0
          ? and(
              eq(roomRosterTable.subjectType, "group"),
              inArray(roomRosterTable.subjectId, subject.groupIds),
            )
          : undefined;

      const rows = await this.db
        .select()
        .from(roomRosterTable)
        .where(groupMatch ? or(userMatch, groupMatch) : userMatch);

      const rooms = new Map<string, Set<RoomCapability>>();

      for (const row of rows) {
        const capabilities = rooms.get(row.roomId) ?? new Set<RoomCapability>();

        for (const capability of capabilitiesFromValue(row.capabilities)) {
          capabilities.add(capability);
        }

        rooms.set(row.roomId, capabilities);
      }

      return rooms;
    } catch (error) {
      await this.failover("room roster subject query unavailable; using JSON store", error);
      return this.fallback.roomsForSubject(subject);
    }
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }
}

function loadRoster(): RosterRecord[] {
  if (!existsSync(roomRosterStorePath)) {
    return [];
  }

  const raw = readFileSync(roomRosterStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const roster = isRosterStore(parsed) ? parsed.roster : parsed;

  if (!Array.isArray(roster)) {
    throw new Error("room_roster_store_invalid");
  }

  return roster.map(rosterRecordFromValue).filter((row): row is RosterRecord => row !== undefined);
}

function rosterEntryFromRecord(row: RosterRecord): RoomRosterEntry {
  return {
    capabilities: row.capabilities,
    source: row.source,
    ...(row.sourceScheduleId ? { sourceScheduleId: row.sourceScheduleId } : {}),
    subjectId: row.subjectId,
    subjectType: row.subjectType,
  };
}

function rosterRecordFromRow(row: RoomRosterRow): RosterRecord {
  return {
    capabilities: capabilitiesFromValue(row.capabilities),
    grantedByUserId: row.grantedByUserId ?? null,
    roomId: row.roomId,
    source: row.source,
    sourceScheduleId: row.sourceScheduleId ?? null,
    subjectId: row.subjectId,
    subjectType: row.subjectType,
  };
}

function rosterRecordFromValue(value: unknown): RosterRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const subjectType = subjectTypeFromValue(value.subjectType);
  const source = sourceFromValue(value.source);

  if (
    !subjectType ||
    !source ||
    typeof value.roomId !== "string" ||
    typeof value.subjectId !== "string"
  ) {
    return undefined;
  }

  return {
    capabilities: capabilitiesFromValue(value.capabilities),
    grantedByUserId: typeof value.grantedByUserId === "string" ? value.grantedByUserId : null,
    roomId: value.roomId,
    source,
    sourceScheduleId: typeof value.sourceScheduleId === "string" ? value.sourceScheduleId : null,
    subjectId: value.subjectId,
    subjectType,
  };
}

function subjectMatches(row: RosterRecord, subject: RosterSubject) {
  if (row.subjectType === "user") {
    return row.subjectId === subject.userId;
  }

  return subject.groupIds.includes(row.subjectId);
}

function sanitizeCapabilities(capabilities: RoomCapability[]): RoomCapability[] {
  return capabilitiesFromValue(capabilities);
}

function capabilitiesFromValue(value: unknown): RoomCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const capabilities: RoomCapability[] = [];

  for (const item of value) {
    const parsed = roomCapabilitySchema.safeParse(item);

    if (parsed.success && !capabilities.includes(parsed.data)) {
      capabilities.push(parsed.data);
    }
  }

  return capabilities;
}

function subjectTypeFromValue(value: unknown): SubjectType | undefined {
  return value === "user" || value === "group" ? value : undefined;
}

function sourceFromValue(value: unknown): "manual" | "calendar" | undefined {
  return value === "manual" || value === "calendar" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRosterStore(value: unknown): value is { roster: unknown[] } {
  return isRecord(value) && Array.isArray(value.roster);
}
