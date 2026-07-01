import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, eq, uploadDestinations as uploadDestinationsTable } from "@rakkr/db";
import { DatabaseUnavailableError } from "./database-unavailable.js";
import {
  uploadDestinationInputSchema,
  uploadDestinationSchema,
  uploadDestinationUpdateSchema,
  type UploadDestination,
  type UploadDestinationInput,
  type UploadDestinationKind,
  type UploadDestinationRuntimeStatus,
  type UploadDestinationUpdate,
} from "@rakkr/shared";
import { decryptSecret, encryptSecret } from "./secret-box.js";

type UploadDestinationRow = typeof uploadDestinationsTable.$inferSelect;

interface SecretFlags {
  hasS3SecretAccessKey: boolean;
  hasSmbPassword: boolean;
}

interface UploadDestinationDriver {
  implemented: boolean;
  missingFields(destination: UploadDestination, flags: SecretFlags): string[];
  requiredFields: string[];
}

// Encrypted secret material persisted alongside the non-secret config.
interface StoredSecrets {
  s3SecretAccessKey?: string;
  smbPassword?: string;
}

// What the stores persist: non-secret typed config + encrypted secrets.
interface StoredDestination {
  destination: UploadDestination;
  secrets: StoredSecrets;
}

// Decrypted config handed to the upload executor only. Never serialized to API
// responses or audit events.
export interface ResolvedUploadDestinationConfig extends UploadDestination {
  s3SecretAccessKey?: string;
  smbPassword?: string;
}

const destinationStorePath = path.resolve(
  process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH ?? "data/upload-destinations.json",
);

const uploadDestinationDrivers: Record<UploadDestinationKind, UploadDestinationDriver> = {
  s3: {
    implemented: true,
    missingFields(destination, flags) {
      const s3 = destination.s3 ?? {};
      const missing: string[] = [];

      if (!s3.bucket) {
        missing.push("s3.bucket");
      }
      if (!s3.accessKeyId) {
        missing.push("s3.accessKeyId");
      }
      if (!flags.hasS3SecretAccessKey) {
        missing.push("s3.secretAccessKey");
      }
      if (!s3.region && !s3.endpoint) {
        missing.push("s3.region|s3.endpoint");
      }

      return missing;
    },
    requiredFields: ["s3.bucket", "s3.accessKeyId", "s3.secretAccessKey", "s3.region|s3.endpoint"],
  },
  smb: {
    implemented: true,
    missingFields(destination, flags) {
      const smb = destination.smb ?? {};
      const missing: string[] = [];

      if (!smb.server) {
        missing.push("smb.server");
      }
      if (!smb.share) {
        missing.push("smb.share");
      }
      if (!smb.username) {
        missing.push("smb.username");
      }
      if (!flags.hasSmbPassword) {
        missing.push("smb.password");
      }

      return missing;
    },
    requiredFields: ["smb.server", "smb.share", "smb.username", "smb.password"],
  },
};

export interface UploadDestinationStore {
  create(input: UploadDestinationInput): Promise<UploadDestinationRuntimeStatus>;
  delete(id: string): Promise<boolean>;
  find(id: string): Promise<UploadDestinationRuntimeStatus | undefined>;
  list(): Promise<UploadDestinationRuntimeStatus[]>;
  resolveConfig(id: string): Promise<ResolvedUploadDestinationConfig | undefined>;
  update(
    id: string,
    input: UploadDestinationUpdate,
  ): Promise<UploadDestinationRuntimeStatus | undefined>;
}

class JsonUploadDestinationStore implements UploadDestinationStore {
  private readonly stored = loadStoredDestinations();

  async list() {
    return [...this.stored]
      .sort((left, right) =>
        left.destination.displayName.localeCompare(right.destination.displayName),
      )
      .map(uploadDestinationRuntimeStatus);
  }

  async find(id: string) {
    const stored = this.storedFor(id);

    return stored ? uploadDestinationRuntimeStatus(stored) : undefined;
  }

  async resolveConfig(id: string) {
    const stored = this.storedFor(id);

    return stored ? resolvedConfig(stored) : undefined;
  }

  async create(input: UploadDestinationInput) {
    const next = createStored(input);

    this.stored.unshift(next);
    this.persist();

    return uploadDestinationRuntimeStatus(next);
  }

  async update(id: string, input: UploadDestinationUpdate) {
    const index = this.stored.findIndex((entry) => entry.destination.id === id);

    if (index < 0) {
      return undefined;
    }

    const next = applyDestinationUpdate(this.stored[index], input);

    this.stored[index] = next;
    this.persist();

    return uploadDestinationRuntimeStatus(next);
  }

  async delete(id: string) {
    const index = this.stored.findIndex((entry) => entry.destination.id === id);

    if (index < 0) {
      return false;
    }

    this.stored.splice(index, 1);
    this.persist();

    return true;
  }

  private storedFor(id: string) {
    return this.stored.find((entry) => entry.destination.id === id);
  }

  private persist() {
    mkdirSync(path.dirname(destinationStorePath), { recursive: true });
    const tempPath = `${destinationStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        destinations: this.stored,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, destinationStorePath);
  }
}

class PostgresUploadDestinationStore implements UploadDestinationStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: UploadDestinationStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async list() {
    if (!this.dbAvailable) {
      return this.fallback.list();
    }

    try {
      const rows = await this.db.select().from(uploadDestinationsTable);

      return rows
        .map(storedFromRow)
        .sort((left, right) =>
          left.destination.displayName.localeCompare(right.destination.displayName),
        )
        .map(uploadDestinationRuntimeStatus);
    } catch (error) {
      await this.failover("upload destination query unavailable; using JSON store", error);
      return this.fallback.list();
    }
  }

  async find(id: string) {
    if (!this.dbAvailable) {
      return this.fallback.find(id);
    }

    try {
      const stored = await this.storedFor(id);

      return stored ? uploadDestinationRuntimeStatus(stored) : undefined;
    } catch (error) {
      await this.failover("upload destination lookup unavailable; using JSON store", error);
      return this.fallback.find(id);
    }
  }

  async resolveConfig(id: string) {
    if (!this.dbAvailable) {
      return this.fallback.resolveConfig(id);
    }

    try {
      const stored = await this.storedFor(id);

      return stored ? resolvedConfig(stored) : undefined;
    } catch (error) {
      await this.failover("upload destination resolve unavailable; using JSON store", error);
      return this.fallback.resolveConfig(id);
    }
  }

  async create(input: UploadDestinationInput) {
    if (!this.dbAvailable) {
      return this.fallback.create(input);
    }

    try {
      const next = createStored(input);

      await this.db.insert(uploadDestinationsTable).values(storedToRow(next));

      return uploadDestinationRuntimeStatus(next);
    } catch (error) {
      await this.failover("upload destination create unavailable; using JSON store", error);
      return this.fallback.create(input);
    }
  }

  async update(id: string, input: UploadDestinationUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(id, input);
    }

    try {
      const existing = await this.storedFor(id);

      if (!existing) {
        return undefined;
      }

      const next = applyDestinationUpdate(existing, input);
      const row = storedToRow(next);

      await this.db
        .update(uploadDestinationsTable)
        .set({
          config: row.config,
          displayName: row.displayName,
          enabled: row.enabled,
          secrets: row.secrets,
          updatedAt: row.updatedAt,
        })
        .where(eq(uploadDestinationsTable.id, id));

      return uploadDestinationRuntimeStatus(next);
    } catch (error) {
      await this.failover("upload destination update unavailable; using JSON store", error);
      return this.fallback.update(id, input);
    }
  }

  async delete(id: string) {
    if (!this.dbAvailable) {
      return this.fallback.delete(id);
    }

    try {
      const deleted = await this.db
        .delete(uploadDestinationsTable)
        .where(eq(uploadDestinationsTable.id, id))
        .returning({ id: uploadDestinationsTable.id });

      return deleted.length > 0;
    } catch (error) {
      await this.failover("upload destination delete unavailable; using JSON store", error);
      return this.fallback.delete(id);
    }
  }

  private async storedFor(id: string) {
    const [row] = await this.db
      .select()
      .from(uploadDestinationsTable)
      .where(eq(uploadDestinationsTable.id, id))
      .limit(1);

    return row ? storedFromRow(row) : undefined;
  }

  private async failover(message: string, error: unknown): Promise<never> {
    throw new DatabaseUnavailableError(message, error);
  }
}

export function createUploadDestinationStore() {
  const fallback = new JsonUploadDestinationStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresUploadDestinationStore(databaseUrl, fallback) : fallback;
}

function createStored(input: UploadDestinationInput): StoredDestination {
  const parsed = uploadDestinationInputSchema.parse(input);
  const destination = uploadDestinationSchema.parse({
    displayName: parsed.displayName,
    enabled: parsed.enabled,
    id: parsed.id ?? `upload_dest_${randomUUID()}`,
    kind: parsed.kind,
    s3: parsed.s3,
    smb: parsed.smb,
    updatedAt: new Date().toISOString(),
  });
  const secrets: StoredSecrets = {};

  if (parsed.smbPassword) {
    secrets.smbPassword = encryptSecret(parsed.smbPassword);
  }

  if (parsed.s3SecretAccessKey) {
    secrets.s3SecretAccessKey = encryptSecret(parsed.s3SecretAccessKey);
  }

  return { destination, secrets };
}

function applyDestinationUpdate(
  existing: StoredDestination,
  input: UploadDestinationUpdate,
): StoredDestination {
  const update = uploadDestinationUpdateSchema.parse(input);
  const destination = uploadDestinationSchema.parse({
    displayName: update.displayName ?? existing.destination.displayName,
    enabled: update.enabled ?? existing.destination.enabled,
    id: existing.destination.id,
    kind: existing.destination.kind,
    s3: update.s3 ?? existing.destination.s3,
    smb: update.smb ?? existing.destination.smb,
    updatedAt: new Date().toISOString(),
  });
  const secrets: StoredSecrets = { ...existing.secrets };

  if (update.smbPassword !== undefined) {
    if (update.smbPassword.length === 0) {
      delete secrets.smbPassword;
    } else {
      secrets.smbPassword = encryptSecret(update.smbPassword);
    }
  }

  if (update.s3SecretAccessKey !== undefined) {
    if (update.s3SecretAccessKey.length === 0) {
      delete secrets.s3SecretAccessKey;
    } else {
      secrets.s3SecretAccessKey = encryptSecret(update.s3SecretAccessKey);
    }
  }

  return { destination, secrets };
}

function uploadDestinationRuntimeStatus(stored: StoredDestination): UploadDestinationRuntimeStatus {
  const { destination, secrets } = stored;
  const flags: SecretFlags = {
    hasS3SecretAccessKey: Boolean(secrets.s3SecretAccessKey),
    hasSmbPassword: Boolean(secrets.smbPassword),
  };
  const driver = uploadDestinationDrivers[destination.kind];
  const missingFields = destination.enabled ? driver.missingFields(destination, flags) : [];
  const status = destinationStatus(destination, driver, missingFields);

  return {
    configured: destination.enabled && missingFields.length === 0,
    displayName: destination.displayName,
    enabled: destination.enabled,
    hasS3SecretAccessKey: flags.hasS3SecretAccessKey,
    hasSmbPassword: flags.hasSmbPassword,
    id: destination.id,
    implemented: driver.implemented,
    kind: destination.kind,
    missingFields,
    reason: destinationReason(status, missingFields),
    requiredFields: driver.requiredFields,
    s3: destination.s3,
    smb: destination.smb,
    status,
    target: deriveDisplayTarget(destination),
    updatedAt: destination.updatedAt,
  };
}

function resolvedConfig(stored: StoredDestination): ResolvedUploadDestinationConfig {
  return {
    ...stored.destination,
    s3SecretAccessKey: stored.secrets.s3SecretAccessKey
      ? decryptSecret(stored.secrets.s3SecretAccessKey)
      : undefined,
    smbPassword: stored.secrets.smbPassword ? decryptSecret(stored.secrets.smbPassword) : undefined,
  };
}

function destinationStatus(
  destination: UploadDestination,
  driver: UploadDestinationDriver,
  missingFields: string[],
): UploadDestinationRuntimeStatus["status"] {
  if (!destination.enabled) {
    return "disabled";
  }

  if (missingFields.length > 0) {
    return "not_configured";
  }

  return driver.implemented ? "ready" : "not_implemented";
}

function destinationReason(
  status: UploadDestinationRuntimeStatus["status"],
  missingFields: string[],
) {
  if (status === "disabled") {
    return "destination_disabled";
  }

  if (status === "not_configured") {
    return `missing_${missingFields.join("_and_")}`;
  }

  if (status === "not_implemented") {
    return "destination_not_implemented";
  }

  return undefined;
}

function deriveDisplayTarget(destination: UploadDestination): string | undefined {
  if (destination.kind === "smb" && destination.smb?.server && destination.smb?.share) {
    const suffix = destination.smb.path ? `/${destination.smb.path.replace(/^\/+/, "")}` : "";

    return `smb://${destination.smb.server}/${destination.smb.share}${suffix}`;
  }

  if (destination.kind === "s3" && destination.s3?.bucket) {
    const suffix = destination.s3.prefix ? `/${destination.s3.prefix.replace(/^\/+/, "")}` : "";

    return `s3://${destination.s3.bucket}${suffix}`;
  }

  return undefined;
}

function loadStoredDestinations(): StoredDestination[] {
  if (!existsSync(destinationStorePath)) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(destinationStorePath, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : isDestinationStore(parsed)
        ? parsed.destinations
        : [];
    const stored: StoredDestination[] = [];

    for (const entry of list) {
      const parsedEntry = parseStoredEntry(entry);

      if (parsedEntry) {
        stored.push(parsedEntry);
      }
    }

    return stored;
  } catch (error) {
    console.warn("upload destination store unreadable; using defaults", error);
    return [];
  }
}

function parseStoredEntry(entry: unknown): StoredDestination | undefined {
  if (!entry || typeof entry !== "object" || !("destination" in entry)) {
    return undefined;
  }

  try {
    const destination = uploadDestinationSchema.parse(
      (entry as { destination: unknown }).destination,
    );

    return {
      destination,
      secrets: sanitizeStoredSecrets((entry as { secrets?: unknown }).secrets),
    };
  } catch {
    return undefined;
  }
}

function isDestinationStore(value: unknown): value is { destinations: unknown[] } {
  return typeof value === "object" && value !== null && "destinations" in value;
}

function sanitizeStoredSecrets(value: unknown): StoredSecrets {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  const secrets: StoredSecrets = {};

  if (typeof record.smbPassword === "string" && record.smbPassword.length > 0) {
    secrets.smbPassword = record.smbPassword;
  }

  if (typeof record.s3SecretAccessKey === "string" && record.s3SecretAccessKey.length > 0) {
    secrets.s3SecretAccessKey = record.s3SecretAccessKey;
  }

  return secrets;
}

function storedFromRow(row: UploadDestinationRow): StoredDestination {
  const rawConfig = (row.config ?? {}) as { s3?: unknown; smb?: unknown };
  const destination = uploadDestinationSchema.parse({
    displayName: row.displayName,
    enabled: row.enabled,
    id: row.id,
    kind: row.kind,
    s3: rawConfig.s3 ?? undefined,
    smb: rawConfig.smb ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  });

  return { destination, secrets: sanitizeStoredSecrets(row.secrets) };
}

function storedToRow(stored: StoredDestination) {
  return {
    config: { s3: stored.destination.s3, smb: stored.destination.smb },
    displayName: stored.destination.displayName,
    enabled: stored.destination.enabled,
    id: stored.destination.id,
    kind: stored.destination.kind,
    secrets: {
      s3SecretAccessKey: stored.secrets.s3SecretAccessKey,
      smbPassword: stored.secrets.smbPassword,
    },
    updatedAt: new Date(stored.destination.updatedAt),
  };
}
