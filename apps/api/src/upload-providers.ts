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

type UploadProviderConfigField = "credentialRef" | "target";
type UploadProviderRow = typeof uploadProvidersTable.$inferSelect;

interface UploadProviderDriver {
  implemented: boolean;
  provider: UploadProvider;
  requiredFields: UploadProviderConfigField[];
}

const providerStorePath = path.resolve(
  process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH ?? "data/upload-providers.json",
);

const uploadProviderDrivers: Record<UploadProvider, UploadProviderDriver> = {
  s3: {
    implemented: true,
    provider: "s3",
    requiredFields: ["target", "credentialRef"],
  },
  smb: {
    implemented: true,
    provider: "smb",
    requiredFields: ["target"],
  },
  stub: {
    implemented: true,
    provider: "stub",
    requiredFields: [],
  },
};

export interface UploadProviderStore {
  findStatus(provider: UploadProvider): Promise<UploadProviderRuntimeStatus>;
  listStatuses(): Promise<UploadProviderRuntimeStatus[]>;
  update(
    provider: UploadProvider,
    input: UploadProviderConfigUpdate,
  ): Promise<UploadProviderRuntimeStatus | undefined>;
}

class JsonUploadProviderStore implements UploadProviderStore {
  private readonly configs = loadProviderConfigs();

  async listStatuses() {
    return this.configs.map(uploadProviderRuntimeStatus);
  }

  async findStatus(provider: UploadProvider) {
    return uploadProviderRuntimeStatus(this.configFor(provider));
  }

  async update(provider: UploadProvider, input: UploadProviderConfigUpdate) {
    const update = uploadProviderConfigUpdateSchema.parse(input);
    const index = this.configs.findIndex((config) => config.provider === provider);

    if (index < 0) {
      return undefined;
    }

    const next = uploadProviderConfigSchema.parse({
      ...this.configs[index],
      ...update,
      provider,
      updatedAt: new Date().toISOString(),
    });

    this.configs[index] = next;
    this.persist();

    return uploadProviderRuntimeStatus(next);
  }

  private configFor(provider: UploadProvider) {
    return this.configs.find((config) => config.provider === provider) ?? defaultConfig(provider);
  }

  private persist() {
    mkdirSync(path.dirname(providerStorePath), { recursive: true });
    const tempPath = `${providerStorePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      {
        providers: this.configs,
        updatedAt: new Date().toISOString(),
        version: 1,
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
      const configs = await this.listConfigs();

      return configs.map(uploadProviderRuntimeStatus);
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
      const [row] = await this.db
        .select()
        .from(uploadProvidersTable)
        .where(eq(uploadProvidersTable.provider, provider))
        .limit(1);

      return uploadProviderRuntimeStatus(row ? configFromRow(row) : defaultConfig(provider));
    } catch (error) {
      await this.failover("upload provider lookup unavailable; using JSON store", error);
      return this.fallback.findStatus(provider);
    }
  }

  async update(provider: UploadProvider, input: UploadProviderConfigUpdate) {
    if (!this.dbAvailable) {
      return this.fallback.update(provider, input);
    }

    try {
      const existing = configFromStatus(await this.findStatus(provider));
      const next = uploadProviderConfigSchema.parse({
        ...existing,
        ...uploadProviderConfigUpdateSchema.parse(input),
        provider,
        updatedAt: new Date().toISOString(),
      });

      await this.writeConfig(next);

      return uploadProviderRuntimeStatus(next);
    } catch (error) {
      await this.failover("upload provider update unavailable; using JSON store", error);
      return this.fallback.update(provider, input);
    }
  }

  private async listConfigs() {
    const rows = await this.db.select().from(uploadProvidersTable);
    const byProvider = new Map(defaultProviderConfigs().map((config) => [config.provider, config]));

    for (const row of rows) {
      byProvider.set(row.provider as UploadProvider, configFromRow(row));
    }

    return orderedProviders().map((provider) => byProvider.get(provider)!);
  }

  private async writeConfig(config: UploadProviderConfig) {
    await this.db
      .insert(uploadProvidersTable)
      .values(configToRow(config))
      .onConflictDoUpdate({
        set: {
          credentialRef: config.credentialRef ?? null,
          displayName: config.displayName,
          enabled: config.enabled,
          target: config.target ?? null,
          updatedAt: new Date(config.updatedAt),
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

export function uploadProviderRuntimeStatus(
  config: UploadProviderConfig,
): UploadProviderRuntimeStatus {
  const driver = uploadProviderDrivers[config.provider];
  const missingFields = config.enabled
    ? driver.requiredFields.filter((field) => !config[field])
    : [];
  const configured = config.enabled && missingFields.length === 0;
  const status = providerStatus(config, driver, missingFields);

  return {
    configured,
    credentialRef: config.credentialRef,
    displayName: config.displayName,
    enabled: config.enabled,
    implemented: driver.implemented,
    missingFields,
    provider: config.provider,
    reason: providerReason(status, missingFields),
    requiredFields: driver.requiredFields,
    status,
    target: config.target,
    updatedAt: config.updatedAt,
  };
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

function loadProviderConfigs() {
  const loaded = existsSync(providerStorePath) ? readProviderConfigs() : [];
  const byProvider = new Map(defaultProviderConfigs().map((config) => [config.provider, config]));

  for (const config of loaded) {
    byProvider.set(config.provider, config);
  }

  return orderedProviders().map((provider) => byProvider.get(provider)!);
}

function readProviderConfigs() {
  const raw = readFileSync(providerStorePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const providers = isProviderStore(parsed) ? parsed.providers : parsed;

  if (!Array.isArray(providers)) {
    throw new Error("upload_provider_store_invalid");
  }

  return providers.map((provider) => uploadProviderConfigSchema.parse(provider));
}

function isProviderStore(value: unknown): value is { providers: unknown[] } {
  return typeof value === "object" && value !== null && "providers" in value;
}

function defaultProviderConfigs() {
  return orderedProviders().map((provider) => defaultConfig(provider));
}

function defaultConfig(provider: UploadProvider): UploadProviderConfig {
  const updatedAt = new Date(0).toISOString();

  if (provider === "stub") {
    return {
      displayName: "Stub Queue Provider",
      enabled: true,
      provider,
      target: "stub://queue-only",
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

function configFromRow(row: UploadProviderRow): UploadProviderConfig {
  return uploadProviderConfigSchema.parse({
    credentialRef: row.credentialRef ?? undefined,
    displayName: row.displayName,
    enabled: row.enabled,
    provider: row.provider,
    target: row.target ?? undefined,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function configFromStatus(status: UploadProviderRuntimeStatus): UploadProviderConfig {
  return uploadProviderConfigSchema.parse({
    credentialRef: status.credentialRef,
    displayName: status.displayName,
    enabled: status.enabled,
    provider: status.provider,
    target: status.target,
    updatedAt: status.updatedAt,
  });
}

function configToRow(config: UploadProviderConfig) {
  return {
    credentialRef: config.credentialRef ?? null,
    displayName: config.displayName,
    enabled: config.enabled,
    provider: config.provider,
    target: config.target ?? null,
    updatedAt: new Date(config.updatedAt),
  };
}
