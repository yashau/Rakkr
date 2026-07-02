import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createDatabase,
  eq,
  switcherInputMap as inputMapTable,
  switcherOutputMap as outputMapTable,
} from "@rakkr/db";

import { DatabaseUnavailableError } from "./database-unavailable.js";

export interface SwitcherInputBinding {
  input: number;
  roomId: string;
}

export interface SwitcherOutputBinding {
  output: number;
  userId: string;
}

export interface StoredSwitcherMappings {
  inputs: SwitcherInputBinding[];
  outputs: SwitcherOutputBinding[];
}

export interface SwitcherMappingStore {
  get(switcherId: string): Promise<StoredSwitcherMappings>;
  replace(switcherId: string, mappings: StoredSwitcherMappings): Promise<StoredSwitcherMappings>;
}

const emptyMappings = (): StoredSwitcherMappings => ({ inputs: [], outputs: [] });

function normalize(mappings: StoredSwitcherMappings): StoredSwitcherMappings {
  return {
    inputs: [...mappings.inputs].sort((left, right) => left.input - right.input),
    outputs: [...mappings.outputs].sort((left, right) => left.output - right.output),
  };
}

const mappingStorePath = path.resolve(
  process.env.RAKKR_SWITCHER_MAPPING_STORE_PATH ?? "data/switcher-mappings.json",
);

class JsonSwitcherMappingStore implements SwitcherMappingStore {
  private readonly bySwitcher = loadStoredMappings();

  async get(switcherId: string) {
    return normalize(this.bySwitcher[switcherId] ?? emptyMappings());
  }

  async replace(switcherId: string, mappings: StoredSwitcherMappings) {
    const next = normalize(mappings);

    this.bySwitcher[switcherId] = next;
    this.persist();

    return next;
  }

  private persist() {
    mkdirSync(path.dirname(mappingStorePath), { recursive: true });
    const tempPath = `${mappingStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      { mappings: this.bySwitcher, updatedAt: new Date().toISOString(), version: 1 },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, mappingStorePath);
  }
}

class PostgresSwitcherMappingStore implements SwitcherMappingStore {
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: SwitcherMappingStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async get(switcherId: string) {
    try {
      const [inputs, outputs] = await Promise.all([
        this.db.select().from(inputMapTable).where(eq(inputMapTable.switcherId, switcherId)),
        this.db.select().from(outputMapTable).where(eq(outputMapTable.switcherId, switcherId)),
      ]);

      return normalize({
        inputs: inputs.map((row) => ({ input: row.input, roomId: row.roomId })),
        outputs: outputs.map((row) => ({ output: row.output, userId: row.userId })),
      });
    } catch (error) {
      await this.failover("switcher mapping query unavailable; using JSON store", error);
      return this.fallback.get(switcherId);
    }
  }

  async replace(switcherId: string, mappings: StoredSwitcherMappings) {
    const next = normalize(mappings);

    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(inputMapTable).where(eq(inputMapTable.switcherId, switcherId));
        await tx.delete(outputMapTable).where(eq(outputMapTable.switcherId, switcherId));

        if (next.inputs.length > 0) {
          await tx.insert(inputMapTable).values(
            next.inputs.map((entry) => ({
              input: entry.input,
              roomId: entry.roomId,
              switcherId,
            })),
          );
        }

        if (next.outputs.length > 0) {
          await tx.insert(outputMapTable).values(
            next.outputs.map((entry) => ({
              output: entry.output,
              switcherId,
              userId: entry.userId,
            })),
          );
        }
      });

      return next;
    } catch (error) {
      await this.failover("switcher mapping replace unavailable; using JSON store", error);
      return this.fallback.replace(switcherId, mappings);
    }
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }
}

export function createSwitcherMappingStore(): SwitcherMappingStore {
  const fallback = new JsonSwitcherMappingStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresSwitcherMappingStore(databaseUrl, fallback) : fallback;
}

function loadStoredMappings(): Record<string, StoredSwitcherMappings> {
  if (!existsSync(mappingStorePath)) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(mappingStorePath, "utf8"));

    if (!parsed || typeof parsed !== "object" || !("mappings" in parsed)) {
      return {};
    }

    const raw = (parsed as { mappings: unknown }).mappings;

    if (!raw || typeof raw !== "object") {
      return {};
    }

    const result: Record<string, StoredSwitcherMappings> = {};

    for (const [switcherId, value] of Object.entries(raw as Record<string, unknown>)) {
      result[switcherId] = sanitizeMappings(value);
    }

    return result;
  } catch (error) {
    console.warn("switcher mapping store unreadable; using defaults", error);
    return {};
  }
}

function sanitizeMappings(value: unknown): StoredSwitcherMappings {
  if (!value || typeof value !== "object") {
    return emptyMappings();
  }

  const record = value as { inputs?: unknown; outputs?: unknown };
  const inputs: SwitcherInputBinding[] = [];
  const outputs: SwitcherOutputBinding[] = [];

  if (Array.isArray(record.inputs)) {
    for (const entry of record.inputs) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { input?: unknown }).input === "number" &&
        typeof (entry as { roomId?: unknown }).roomId === "string"
      ) {
        inputs.push({
          input: (entry as { input: number }).input,
          roomId: (entry as { roomId: string }).roomId,
        });
      }
    }
  }

  if (Array.isArray(record.outputs)) {
    for (const entry of record.outputs) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { output?: unknown }).output === "number" &&
        typeof (entry as { userId?: unknown }).userId === "string"
      ) {
        outputs.push({
          output: (entry as { output: number }).output,
          userId: (entry as { userId: string }).userId,
        });
      }
    }
  }

  return { inputs, outputs };
}
