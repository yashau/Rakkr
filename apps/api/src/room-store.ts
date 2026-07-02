import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, createDatabase, eq, rooms as roomsTable } from "@rakkr/db";
import { type Room, type RoomUpdate, roomSchema } from "@rakkr/shared";
import { DatabaseUnavailableError } from "./database-unavailable.js";

type RoomInsert = typeof roomsTable.$inferInsert;
type RoomRow = typeof roomsTable.$inferSelect;

export class RoomStoreError extends Error {
  constructor(
    message: string,
    readonly code: "room_exists",
  ) {
    super(message);
  }
}

export interface RoomStore {
  create(room: Room): Promise<Room>;
  delete(roomId: string): Promise<Room | undefined>;
  find(roomId: string): Promise<Room | undefined>;
  list(): Promise<Room[]>;
  update(roomId: string, updates: RoomUpdate): Promise<Room | undefined>;
}

const roomStorePath = path.resolve(process.env.RAKKR_ROOM_STORE_PATH ?? "data/rooms.json");

export function createRoomStore(seedRooms: Room[] = []): RoomStore {
  const fallback = new JsonRoomStore(seedRooms);
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresRoomStore(databaseUrl, fallback, seedRooms) : fallback;
}

class JsonRoomStore implements RoomStore {
  private readonly rooms: Room[];

  constructor(seedRooms: Room[]) {
    this.rooms = loadRooms(seedRooms);
  }

  async create(room: Room) {
    const normalized = normalizeRoom(room);

    if (
      this.rooms.some(
        (candidate) =>
          candidate.id === normalized.id ||
          (candidate.site === normalized.site && candidate.name === normalized.name),
      )
    ) {
      throw new RoomStoreError("Room already exists", "room_exists");
    }

    this.rooms.push(normalized);
    this.persist();

    return normalized;
  }

  async delete(roomId: string) {
    const index = this.rooms.findIndex((room) => room.id === roomId);

    if (index < 0) {
      return undefined;
    }

    const [deleted] = this.rooms.splice(index, 1);
    this.persist();

    return deleted;
  }

  async find(roomId: string) {
    return this.rooms.find((room) => room.id === roomId);
  }

  async list() {
    return [...this.rooms].sort(compareRooms);
  }

  async update(roomId: string, updates: RoomUpdate) {
    const index = this.rooms.findIndex((room) => room.id === roomId);

    if (index < 0) {
      return undefined;
    }

    const updated = mergeRoom(this.rooms[index], updates);
    this.rooms[index] = updated;
    this.persist();

    return updated;
  }

  private persist() {
    mkdirSync(path.dirname(roomStorePath), { recursive: true });
    const tempPath = `${roomStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        rooms: this.rooms,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, roomStorePath);
  }
}

class PostgresRoomStore implements RoomStore {
  private dbAvailable = true;
  private hasSeeded = false;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: RoomStore,
    private readonly seedRooms: Room[],
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async create(room: Room) {
    if (!this.dbAvailable) {
      return this.fallback.create(room);
    }

    const normalized = normalizeRoom(room);

    try {
      await this.seedIfEmpty();

      if (await this.conflicts(normalized)) {
        throw new RoomStoreError("Room already exists", "room_exists");
      }

      await this.write(normalized);

      return normalized;
    } catch (error) {
      if (error instanceof RoomStoreError) {
        throw error;
      }

      await this.failover("room persistence unavailable; using JSON store", error);
      return this.fallback.create(room);
    }
  }

  async delete(roomId: string) {
    if (!this.dbAvailable) {
      return this.fallback.delete(roomId);
    }

    try {
      await this.seedIfEmpty();
      const existing = await this.findRow(roomId);

      if (!existing) {
        return undefined;
      }

      await this.db.delete(roomsTable).where(eq(roomsTable.id, roomId));

      return roomFromRow(existing);
    } catch (error) {
      await this.failover("room delete unavailable; using JSON store", error);
      return this.fallback.delete(roomId);
    }
  }

  async find(roomId: string) {
    if (!this.dbAvailable) {
      return this.fallback.find(roomId);
    }

    try {
      await this.seedIfEmpty();
      const row = await this.findRow(roomId);

      return row ? roomFromRow(row) : undefined;
    } catch (error) {
      await this.failover("room lookup unavailable; using JSON store", error);
      return this.fallback.find(roomId);
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
        .from(roomsTable)
        .orderBy(roomsTable.site, roomsTable.name);

      return rows.map(roomFromRow);
    } catch (error) {
      await this.failover("room query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async update(roomId: string, updates: RoomUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(roomId, updates);
    }

    try {
      await this.seedIfEmpty();
      const existing = await this.findRow(roomId);

      if (!existing) {
        return undefined;
      }

      const updated = mergeRoom(roomFromRow(existing), updates);
      await this.write(updated);

      return updated;
    } catch (error) {
      await this.failover("room update unavailable; using JSON store", error);
      return this.fallback.update(roomId, updates);
    }
  }

  private async conflicts(room: Room) {
    const existingById = await this.findRow(room.id);

    if (existingById) {
      return true;
    }

    const [existingByName] = await this.db
      .select({ id: roomsTable.id })
      .from(roomsTable)
      .where(and(eq(roomsTable.site, room.site), eq(roomsTable.name, room.name)))
      .limit(1);

    return existingByName !== undefined;
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }

  private async findRow(roomId: string) {
    const [row] = await this.db.select().from(roomsTable).where(eq(roomsTable.id, roomId)).limit(1);

    return row;
  }

  private async seedIfEmpty() {
    if (this.hasSeeded || this.seedRooms.length === 0 || process.env.RAKKR_SEED_DEMO_DATA === "0") {
      return;
    }

    const existing = await this.db.select({ id: roomsTable.id }).from(roomsTable).limit(1);

    if (existing.length === 0) {
      await Promise.all(this.seedRooms.map((room) => this.write(normalizeRoom(room))));
    }

    this.hasSeeded = true;
  }

  private async write(room: Room) {
    const row = roomToRow(room);

    await this.db
      .insert(roomsTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
          building: row.building,
          description: row.description,
          floor: row.floor,
          name: row.name,
          notes: row.notes,
          site: row.site,
          updatedAt: new Date(),
        },
        target: roomsTable.id,
      });
  }
}

function loadRooms(seedRooms: Room[]) {
  if (!existsSync(roomStorePath)) {
    return seedRooms.map(normalizeRoom);
  }

  const raw = readFileSync(roomStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const rooms = isRoomStore(parsed) ? parsed.rooms : parsed;

  if (!Array.isArray(rooms)) {
    throw new Error("room_store_invalid");
  }

  return rooms.map(normalizeRoom);
}

function roomToRow(room: Room): RoomInsert {
  return {
    building: room.building ?? null,
    description: room.description ?? null,
    floor: room.floor ?? null,
    id: room.id,
    name: room.name,
    notes: room.notes ?? null,
    site: room.site,
  };
}

function roomFromRow(row: RoomRow): Room {
  return {
    building: stringOrUndefined(row.building),
    description: stringOrUndefined(row.description),
    floor: stringOrUndefined(row.floor),
    id: row.id,
    name: row.name.trim(),
    notes: stringOrUndefined(row.notes),
    site: row.site.trim(),
  };
}

function mergeRoom(current: Room, updates: RoomUpdate): Room {
  return {
    building: mergeNullable(current.building, updates.building),
    description: mergeNullable(current.description, updates.description),
    floor: mergeNullable(current.floor, updates.floor),
    id: current.id,
    name: trimmedOr(updates.name, current.name),
    notes: mergeNullable(current.notes, updates.notes),
    site: trimmedOr(updates.site, current.site),
  };
}

function normalizeRoom(value: unknown): Room {
  return roomSchema.omit({ nodeCount: true }).parse(value);
}

function mergeNullable(current: string | undefined, update: string | null | undefined) {
  if (update === undefined) {
    return current;
  }

  if (update === null) {
    return undefined;
  }

  const trimmed = update.trim();
  return trimmed ? trimmed : undefined;
}

function trimmedOr(update: string | undefined, current: string) {
  if (update === undefined) {
    return current;
  }

  const trimmed = update.trim();
  return trimmed ? trimmed : current;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareRooms(a: Room, b: Room) {
  return a.site.localeCompare(b.site) || a.name.localeCompare(b.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoomStore(value: unknown): value is { rooms: unknown[] } {
  return isRecord(value) && Array.isArray(value.rooms);
}
