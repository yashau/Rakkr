import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDatabase, eq, uploadProviders as uploadProvidersTable } from "@rakkr/db";
import {
  uploadProviderConfigSchema,
  uploadProviderConfigUpdateSchema,
  type UploadProvider,
  type UploadProviderConfig,
  type UploadProviderConfigUpdate,
  type UploadProviderRuntimeStatus,
} from "@rakkr/shared";
import { decryptSecret, encryptSecret } from "./secret-box.js";

type UploadProviderRow = typeof uploadProvidersTable.$inferSelect;

interface SecretFlags {
  hasS3SecretAccessKey: boolean;
  hasSmbPassword: boolean;
}

interface UploadProviderDriver {
  implemented: boolean;
  missingFields(config: UploadProviderConfig, flags: SecretFlags): string[];
  requiredFields: string[];
}

// Encrypted secret material persisted alongside the non-secret config.
interface StoredSecrets {
  s3SecretAccessKey?: string;
  smbPassword?: string;
}

// What the stores persist: non-secret typed config + encrypted secrets.
interface StoredProvider {
  config: UploadProviderConfig;
  secrets: StoredSecrets;
}

// Decrypted config handed to the upload executor only. Never serialized to API
// responses or audit events.
export interface ResolvedUploadProviderConfig extends UploadProviderConfig {
  s3SecretAccessKey?: string;
  smbPassword?: string;
}

const providerStorePath = path.resolve(
  process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH ?? "data/upload-providers.json",
);

const uploadProviderDrivers: Record<UploadProvider, UploadProviderDriver> = {
  s3: {
    implemented: true,
    missingFields(config, flags) {
      const s3 = config.s3 ?? {};
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
    missingFields(config, flags) {
      const smb = config.smb ?? {};
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
  stub: {
    implemented: true,
    missingFields() {
      return [];
    },
    requiredFields: [],
  },
};

export interface UploadProviderStore {
  findStatus(provider: UploadProvider): Promise<UploadProviderRuntimeStatus>;
  listStatuses(): Promise<UploadProviderRuntimeStatus[]>;
  resolveConfig(provider: UploadProvider): Promise<ResolvedUploadProviderConfig>;
  update(
    provider: UploadProvider,
    input: UploadProviderConfigUpdate,
  ): Promise<UploadProviderRuntimeStatus | undefined>;
}

class JsonUploadProviderStore implements UploadProviderStore {
  private readonly stored = loadStoredProviders();

  async listStatuses() {
    return this.stored.map(uploadProviderRuntimeStatus);
  }

  async findStatus(provider: UploadProvider) {
    return uploadProviderRuntimeStatus(this.storedFor(provider));
  }

  async resolveConfig(provider: UploadProvider) {
    return resolvedConfig(this.storedFor(provider));
  }

  async update(provider: UploadProvider, input: UploadProviderConfigUpdate) {
    const index = this.stored.findIndex((entry) => entry.config.provider === provider);

    if (index < 0) {
      return undefined;
    }

    const next = applyProviderUpdate(this.stored[index], provider, input);

    this.stored[index] = next;
    this.persist();

    return uploadProviderRuntimeStatus(next);
  }

  private storedFor(provider: UploadProvider) {
    return (
      this.stored.find((entry) => entry.config.provider === provider) ?? defaultStored(provider)
    );
  }

  private persist() {
    mkdirSync(path.dirname(providerStorePath), { recursive: true });
    const tempPath = `${providerStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        providers: this.stored,
        updatedAt: new Date().toISOString(),
        version: 2,
      },
      null,
      2,
    );

    writeFileSync(tempPath, `${payload}\n`);
    renameSync(tempPath, providerStorePath);
  }
}

class PostgresUploadProviderStore implements UploadProviderStore {
  private dbAvailable = true;
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly fallback: UploadProviderStore,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async listStatuses() {
    if (!this.dbAvailable) {
      return this.fallback.listStatuses();
    }

    try {
      return (await this.listStored()).map(uploadProviderRuntimeStatus);
    } catch (error) {
      await this.failover("upload provider query unavailable; using JSON store", error);
      return this.fallback.listStatuses();
    }
  }

  async findStatus(provider: UploadProvider) {
    if (!this.dbAvailable) {
      return this.fallback.findStatus(provider);
    }

    try {
      return uploadProviderRuntimeStatus(await this.storedFor(provider));
    } catch (error) {
      await this.failover("upload provider lookup unavailable; using JSON store", error);
      return this.fallback.findStatus(provider);
    }
  }

  async resolveConfig(provider: UploadProvider) {
    if (!this.dbAvailable) {
      return this.fallback.resolveConfig(provider);
    }

    try {
      return resolvedConfig(await this.storedFor(provider));
    } catch (error) {
      await this.failover("upload provider resolve unavailable; using JSON store", error);
      return this.fallback.resolveConfig(provider);
    }
  }

  async update(provider: UploadProvider, input: UploadProviderConfigUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(provider, input);
    }

    try {
      const next = applyProviderUpdate(await this.storedFor(provider), provider, input);

      await this.writeStored(next);

      return uploadProviderRuntimeStatus(next);
    } catch (error) {
      await this.failover("upload provider update unavailable; using JSON store", error);
      return this.fallback.update(provider, input);
    }
  }

  private async storedFor(provider: UploadProvider) {
    const [row] = await this.db
      .select()
      .from(uploadProvidersTable)
      .where(eq(uploadProvidersTable.provider, provider))
      .limit(1);

    return row ? storedFromRow(row) : defaultStored(provider);
  }

  private async listStored() {
    const rows = await this.db.select().from(uploadProvidersTable);
    const byProvider = new Map(
      orderedProviders().map((provider) => [provider, defaultStored(provider)]),
    );

    for (const row of rows) {
      byProvider.set(row.provider as UploadProvider, storedFromRow(row));
    }

    return orderedProviders().map((provider) => byProvider.get(provider)!);
  }

  private async writeStored(stored: StoredProvider) {
    const row = storedToRow(stored);

    await this.db
      .insert(uploadProvidersTable)
      .values(row)
      .onConflictDoUpdate({
        set: {
          config: row.config,
          displayName: row.displayName,
          enabled: row.enabled,
          secrets: row.secrets,
          updatedAt: row.updatedAt,
        },
        target: uploadProvidersTable.provider,
      });
  }

  private async failover(message: string, error: unknown) {
    this.dbAvailable = false;
    console.warn(message, error);
  }
}

export function createUploadProviderStore() {
  const fallback = new JsonUploadProviderStore();
  const databaseUrl = process.env.DATABASE_URL;

  return databaseUrl ? new PostgresUploadProviderStore(databaseUrl, fallback) : fallback;
}

function uploadProviderRuntimeStatus(stored: StoredProvider): UploadProviderRuntimeStatus {
  const { config, secrets } = stored;
  const flags: SecretFlags = {
    hasS3SecretAccessKey: Boolean(secrets.s3SecretAccessKey),
    hasSmbPassword: Boolean(secrets.smbPassword),
  };
  const driver = uploadProviderDrivers[config.provider];
  const missingFields = config.enabled ? driver.missingFields(config, flags) : [];
  const status = providerStatus(config, driver, missingFields);

  return {
    configured: config.enabled && missingFields.length === 0,
    displayName: config.displayName,
    enabled: config.enabled,
    hasS3SecretAccessKey: flags.hasS3SecretAccessKey,
    hasSmbPassword: flags.hasSmbPassword,
    implemented: driver.implemented,
    missingFields,
    provider: config.provider,
    reason: providerReason(status, missingFields),
    requiredFields: driver.requiredFields,
    s3: config.s3,
    smb: config.smb,
    status,
    target: deriveDisplayTarget(config),
    updatedAt: config.updatedAt,
  };
}

function resolvedConfig(stored: StoredProvider): ResolvedUploadProviderConfig {
  return {
    ...stored.config,
    s3SecretAccessKey: stored.secrets.s3SecretAccessKey
      ? decryptSecret(stored.secrets.s3SecretAccessKey)
      : undefined,
    smbPassword: stored.secrets.smbPassword ? decryptSecret(stored.secrets.smbPassword) : undefined,
  };
}

function applyProviderUpdate(
  existing: StoredProvider,
  provider: UploadProvider,
  input: UploadProviderConfigUpdate,
): StoredProvider {
  const update = uploadProviderConfigUpdateSchema.parse(input);
  const config = uploadProviderConfigSchema.parse({
    displayName: update.displayName ?? existing.config.displayName,
    enabled: update.enabled ?? existing.config.enabled,
    provider,
    s3: update.s3 ?? existing.config.s3,
    smb: update.smb ?? existing.config.smb,
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

  return { config, secrets };
}

function providerStatus(
  config: UploadProviderConfig,
  driver: UploadProviderDriver,
  missingFields: string[],
): UploadProviderRuntimeStatus["status"] {
  if (!config.enabled) {
    return "disabled";
  }

  if (missingFields.length > 0) {
    return "not_configured";
  }

  return driver.implemented ? "ready" : "not_implemented";
}

function providerReason(status: UploadProviderRuntimeStatus["status"], missingFields: string[]) {
  if (status === "disabled") {
    return "provider_disabled";
  }

  if (status === "not_configured") {
    return `missing_${missingFields.join("_and_")}`;
  }

  if (status === "not_implemented") {
    return "provider_not_implemented";
  }

  return undefined;
}

function deriveDisplayTarget(config: UploadProviderConfig): string | undefined {
  if (config.provider === "stub") {
    return "stub://queue-only";
  }

  if (config.provider === "smb" && config.smb?.server && config.smb?.share) {
    const suffix = config.smb.path ? `/${config.smb.path.replace(/^\/+/, "")}` : "";

    return `smb://${config.smb.server}/${config.smb.share}${suffix}`;
  }

  if (config.provider === "s3" && config.s3?.bucket) {
    const suffix = config.s3.prefix ? `/${config.s3.prefix.replace(/^\/+/, "")}` : "";

    return `s3://${config.s3.bucket}${suffix}`;
  }

  return undefined;
}

function loadStoredProviders(): StoredProvider[] {
  const byProvider = new Map(
    orderedProviders().map((provider) => [provider, defaultStored(provider)]),
  );

  if (existsSync(providerStorePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(providerStorePath, "utf8"));
      const list = Array.isArray(parsed) ? parsed : isProviderStore(parsed) ? parsed.providers : [];

      for (const entry of list) {
        const stored = parseStoredEntry(entry);

        if (stored) {
          byProvider.set(stored.config.provider, stored);
        }
      }
    } catch (error) {
      console.warn("upload provider store unreadable; using defaults", error);
    }
  }

  return orderedProviders().map((provider) => byProvider.get(provider)!);
}

function parseStoredEntry(entry: unknown): StoredProvider | undefined {
  if (!entry || typeof entry !== "object" || !("config" in entry)) {
    return undefined;
  }

  try {
    const config = uploadProviderConfigSchema.parse((entry as { config: unknown }).config);

    return { config, secrets: sanitizeStoredSecrets((entry as { secrets?: unknown }).secrets) };
  } catch {
    return undefined;
  }
}

function isProviderStore(value: unknown): value is { providers: unknown[] } {
  return typeof value === "object" && value !== null && "providers" in value;
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

function defaultStored(provider: UploadProvider): StoredProvider {
  return { config: defaultConfig(provider), secrets: {} };
}

function defaultConfig(provider: UploadProvider): UploadProviderConfig {
  const updatedAt = new Date(0).toISOString();

  if (provider === "stub") {
    return {
      displayName: "Stub Queue Provider",
      enabled: true,
      provider,
      updatedAt,
    };
  }

  return {
    displayName: provider === "smb" ? "SMB Share" : "S3 Bucket",
    enabled: false,
    provider,
    updatedAt,
  };
}

function orderedProviders(): UploadProvider[] {
  return ["stub", "smb", "s3"];
}

function storedFromRow(row: UploadProviderRow): StoredProvider {
  const rawConfig = (row.config ?? {}) as { s3?: unknown; smb?: unknown };
  const config = uploadProviderConfigSchema.parse({
    displayName: row.displayName,
    enabled: row.enabled,
    provider: row.provider,
    s3: rawConfig.s3 ?? undefined,
    smb: rawConfig.smb ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  });

  return { config, secrets: sanitizeStoredSecrets(row.secrets) };
}

function storedToRow(stored: StoredProvider) {
  return {
    config: { s3: stored.config.s3, smb: stored.config.smb },
    displayName: stored.config.displayName,
    enabled: stored.config.enabled,
    provider: stored.config.provider,
    secrets: {
      s3SecretAccessKey: stored.secrets.s3SecretAccessKey,
      smbPassword: stored.secrets.smbPassword,
    },
    updatedAt: new Date(stored.config.updatedAt),
  };
}
