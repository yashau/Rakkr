import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createDatabase, eq, switchers as switchersTable } from "@rakkr/db";
import {
  switcherCreateSchema,
  switcherModelInfo,
  switcherSchema,
  switcherUpdateSchema,
  type Switcher,
  type SwitcherCreate,
  type SwitcherMode,
  type SwitcherModel,
  type SwitcherStatus,
  type SwitcherUpdate,
} from "@rakkr/shared";

import { isPgErrorCode } from "./auth-utils.js";
import { DatabaseUnavailableError } from "./database-unavailable.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import type { SwitcherConnection } from "./switchers/index.js";

type SwitcherRow = typeof switchersTable.$inferSelect;

// A client-error the switcher routes map to a 409 (rather than the failover path
// mislabeling a duplicate-id create as a 503 "database unavailable").
export class SwitcherStoreError extends Error {
  constructor(
    message: string,
    readonly code: "switcher_exists",
  ) {
    super(message);
    this.name = "SwitcherStoreError";
  }
}

// Encrypted control-channel secret material, persisted alongside the config.
interface StoredSecrets {
  password?: string;
}

interface StoredSwitcher {
  secrets: StoredSecrets;
  switcher: Switcher;
}

// Decrypted connection + routing metadata handed to the driver/reconcile loop
// only. Never serialized to API responses or audit events.
export interface ResolvedSwitcherConnection extends SwitcherConnection {
  displayName: string;
  enabled: boolean;
  id: string;
  inputs: number;
  mode: SwitcherMode;
  model: SwitcherModel;
  outputs: number;
}

const switcherStorePath = path.resolve(
  process.env.RAKKR_SWITCHER_STORE_PATH ?? "data/switchers.json",
);

export interface SwitcherStore {
  create(input: SwitcherCreate): Promise<SwitcherStatus>;
  delete(id: string): Promise<boolean>;
  find(id: string): Promise<SwitcherStatus | undefined>;
  list(): Promise<SwitcherStatus[]>;
  resolveConfig(id: string): Promise<ResolvedSwitcherConnection | undefined>;
  update(id: string, input: SwitcherUpdate): Promise<SwitcherStatus | undefined>;
}

class JsonSwitcherStore implements SwitcherStore {
  private readonly stored = loadStoredSwitchers();

  async list() {
    return [...this.stored]
      .sort((left, right) => left.switcher.displayName.localeCompare(right.switcher.displayName))
      .map(switcherStatus);
  }

  async find(id: string) {
    const stored = this.storedFor(id);

    return stored ? switcherStatus(stored) : undefined;
  }

  async resolveConfig(id: string) {
    const stored = this.storedFor(id);

    return stored ? resolvedConnection(stored) : undefined;
  }

  async create(input: SwitcherCreate) {
    const next = createStored(input);

    if (input.id && this.storedFor(next.switcher.id)) {
      throw new SwitcherStoreError("Switcher already exists", "switcher_exists");
    }

    this.stored.unshift(next);
    this.persist();

    return switcherStatus(next);
  }

  async update(id: string, input: SwitcherUpdate) {
    const index = this.stored.findIndex((entry) => entry.switcher.id === id);

    if (index < 0) {
      return undefined;
    }

    const next = applySwitcherUpdate(this.stored[index], input);

    this.stored[index] = next;
    this.persist();

    return switcherStatus(next);
  }

  async delete(id: string) {
    const index = this.stored.findIndex((entry) => entry.switcher.id === id);

    if (index < 0) {
      return false;
    }

    this.stored.splice(index, 1);
    this.persist();

    return true;
  }

  private storedFor(id: string) {
    return this.stored.find((entry) => entry.switcher.id === id);
  }

  private persist() {
    mkdirSync(path.dirname(switcherStorePath), { recursive: true });
    const tempPath = `${switcherStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      { switchers: this.stored, updatedAt: new Date().toISOString(), version: 1 },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, switcherStorePath);
  }
}

class PostgresSwitcherStore implements SwitcherStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: SwitcherStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async list() {
    if (!this.dbAvailable) {
      return this.fallback.list();
    }

    try {
      const rows = await this.db.select().from(switchersTable);

      return rows
        .map(storedFromRow)
        .sort((left, right) => left.switcher.displayName.localeCompare(right.switcher.displayName))
        .map(switcherStatus);
    } catch (error) {
      await this.failover("switcher query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async find(id: string) {
    if (!this.dbAvailable) {
      return this.fallback.find(id);
    }

    try {
      const stored = await this.storedFor(id);

      return stored ? switcherStatus(stored) : undefined;
    } catch (error) {
      await this.failover("switcher lookup unavailable; using JSON store", error);
      return this.fallback.find(id);
    }
  }

  async resolveConfig(id: string) {
    if (!this.dbAvailable) {
      return this.fallback.resolveConfig(id);
    }

    try {
      const stored = await this.storedFor(id);

      return stored ? resolvedConnection(stored) : undefined;
    } catch (error) {
      await this.failover("switcher resolve unavailable; using JSON store", error);
      return this.fallback.resolveConfig(id);
    }
  }

  async create(input: SwitcherCreate) {
    if (!this.dbAvailable) {
      return this.fallback.create(input);
    }

    try {
      const next = createStored(input);

      // An operator-supplied duplicate id is a client error, not a DB outage: reject
      // it as 409 rather than letting the unique-violation fall through to failover
      // (which would mislabel it as 503 "database unavailable"). Mirrors room-store.
      if (input.id && (await this.storedFor(next.switcher.id))) {
        throw new SwitcherStoreError("Switcher already exists", "switcher_exists");
      }

      await this.db.insert(switchersTable).values(storedToRow(next));

      return switcherStatus(next);
    } catch (error) {
      if (error instanceof SwitcherStoreError) {
        throw error;
      }

      // A duplicate id that lost the pre-check race trips the unique constraint
      // (SQLSTATE 23505) — still a 409, not a DB-outage 503.
      if (isPgErrorCode(error, "23505")) {
        throw new SwitcherStoreError("Switcher already exists", "switcher_exists");
      }

      await this.failover("switcher create unavailable; using JSON store", error);
      return this.fallback.create(input);
    }
  }

  async update(id: string, input: SwitcherUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(id, input);
    }

    try {
      const existing = await this.storedFor(id);

      if (!existing) {
        return undefined;
      }

      const next = applySwitcherUpdate(existing, input);
      const row = storedToRow(next);

      await this.db
        .update(switchersTable)
        .set({
          displayName: row.displayName,
          enabled: row.enabled,
          host: row.host,
          mode: row.mode,
          port: row.port,
          secrets: row.secrets,
          updatedAt: row.updatedAt,
          username: row.username,
        })
        .where(eq(switchersTable.id, id));

      return switcherStatus(next);
    } catch (error) {
      await this.failover("switcher update unavailable; using JSON store", error);
      return this.fallback.update(id, input);
    }
  }

  async delete(id: string) {
    if (!this.dbAvailable) {
      return this.fallback.delete(id);
    }

    try {
      const deleted = await this.db
        .delete(switchersTable)
        .where(eq(switchersTable.id, id))
        .returning({ id: switchersTable.id });

      return deleted.length > 0;
    } catch (error) {
      await this.failover("switcher delete unavailable; using JSON store", error);
      return this.fallback.delete(id);
    }
  }

  private async storedFor(id: string) {
    const [row] = await this.db
      .select()
      .from(switchersTable)
      .where(eq(switchersTable.id, id))
      .limit(1);

    return row ? storedFromRow(row) : undefined;
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }
}

export function createSwitcherStore(): SwitcherStore {
  const fallback = new JsonSwitcherStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresSwitcherStore(databaseUrl, fallback) : fallback;
}

function createStored(input: SwitcherCreate): StoredSwitcher {
  const parsed = switcherCreateSchema.parse(input);
  const info = switcherModelInfo(parsed.model);
  const now = new Date().toISOString();
  const switcher = switcherSchema.parse({
    createdAt: now,
    displayName: parsed.displayName,
    enabled: parsed.enabled,
    host: parsed.host,
    id: parsed.id ?? `switcher_${randomUUID()}`,
    inputs: info.inputs,
    mode: parsed.mode,
    model: parsed.model,
    outputs: info.outputs,
    port: parsed.port ?? info.defaultPort,
    updatedAt: now,
    username: parsed.username,
  });
  const secrets: StoredSecrets = {};

  if (parsed.password) {
    secrets.password = encryptSecret(parsed.password);
  }

  return { secrets, switcher };
}

function applySwitcherUpdate(existing: StoredSwitcher, input: SwitcherUpdate): StoredSwitcher {
  const update = switcherUpdateSchema.parse(input);
  const username =
    update.username === null ? undefined : (update.username ?? existing.switcher.username);
  const switcher = switcherSchema.parse({
    createdAt: existing.switcher.createdAt,
    displayName: update.displayName ?? existing.switcher.displayName,
    enabled: update.enabled ?? existing.switcher.enabled,
    host: update.host ?? existing.switcher.host,
    id: existing.switcher.id,
    inputs: existing.switcher.inputs,
    mode: update.mode ?? existing.switcher.mode,
    model: existing.switcher.model,
    outputs: existing.switcher.outputs,
    port: update.port ?? existing.switcher.port,
    updatedAt: new Date().toISOString(),
    username,
  });
  const secrets: StoredSecrets = { ...existing.secrets };

  if (update.password !== undefined) {
    if (update.password.length === 0) {
      delete secrets.password;
    } else {
      secrets.password = encryptSecret(update.password);
    }
  }

  return { secrets, switcher };
}

function switcherStatus(stored: StoredSwitcher): SwitcherStatus {
  return { ...stored.switcher, hasPassword: Boolean(stored.secrets.password) };
}

function resolvedConnection(stored: StoredSwitcher): ResolvedSwitcherConnection {
  return {
    displayName: stored.switcher.displayName,
    enabled: stored.switcher.enabled,
    host: stored.switcher.host,
    id: stored.switcher.id,
    inputs: stored.switcher.inputs,
    mode: stored.switcher.mode,
    model: stored.switcher.model,
    outputs: stored.switcher.outputs,
    password: stored.secrets.password ? decryptSecret(stored.secrets.password) : undefined,
    port: stored.switcher.port,
    username: stored.switcher.username,
  };
}

function sanitizeStoredSecrets(value: unknown): StoredSecrets {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const secrets: StoredSecrets = {};

  if (typeof record.password === "string" && record.password.length > 0) {
    secrets.password = record.password;
  }

  return secrets;
}

function storedFromRow(row: SwitcherRow): StoredSwitcher {
  const switcher = switcherSchema.parse({
    createdAt: row.createdAt.toISOString(),
    displayName: row.displayName,
    enabled: row.enabled,
    host: row.host,
    id: row.id,
    inputs: row.inputs,
    mode: row.mode,
    model: row.model,
    outputs: row.outputs,
    port: row.port,
    updatedAt: row.updatedAt.toISOString(),
    username: row.username ?? undefined,
  });

  return { secrets: sanitizeStoredSecrets(row.secrets), switcher };
}

function storedToRow(stored: StoredSwitcher) {
  return {
    createdAt: new Date(stored.switcher.createdAt),
    displayName: stored.switcher.displayName,
    enabled: stored.switcher.enabled,
    host: stored.switcher.host,
    id: stored.switcher.id,
    inputs: stored.switcher.inputs,
    mode: stored.switcher.mode,
    model: stored.switcher.model,
    outputs: stored.switcher.outputs,
    port: stored.switcher.port,
    secrets: { password: stored.secrets.password },
    updatedAt: new Date(stored.switcher.updatedAt),
    username: stored.switcher.username ?? null,
  };
}

function loadStoredSwitchers(): StoredSwitcher[] {
  if (!existsSync(switcherStorePath)) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(switcherStorePath, "utf8"));
    const list = isSwitcherStoreFile(parsed) ? parsed.switchers : [];
    const stored: StoredSwitcher[] = [];

    for (const entry of list) {
      const parsedEntry = parseStoredEntry(entry);

      if (parsedEntry) {
        stored.push(parsedEntry);
      }
    }

    return stored;
  } catch (error) {
    console.warn("switcher store unreadable; using defaults", error);
    return [];
  }
}

function parseStoredEntry(entry: unknown): StoredSwitcher | undefined {
  if (!entry || typeof entry !== "object" || !("switcher" in entry)) {
    return undefined;
  }

  try {
    const switcher = switcherSchema.parse((entry as { switcher: unknown }).switcher);

    return { secrets: sanitizeStoredSecrets((entry as { secrets?: unknown }).secrets), switcher };
  } catch {
    return undefined;
  }
}

function isSwitcherStoreFile(value: unknown): value is { switchers: unknown[] } {
  return typeof value === "object" && value !== null && "switchers" in value;
}
