import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  uploadProviderConfigSchema,
  uploadProviderConfigUpdateSchema,
  type UploadProvider,
  type UploadProviderConfig,
  type UploadProviderConfigUpdate,
  type UploadProviderRuntimeStatus,
} from "@rakkr/shared";

type UploadProviderConfigField = "credentialRef" | "target";

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

export class UploadProviderStore {
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

export function createUploadProviderStore() {
  return new UploadProviderStore();
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

  return ["stub", "smb", "s3"].map((provider) => byProvider.get(provider as UploadProvider)!);
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
  return ["stub", "smb", "s3"].map((provider) => defaultConfig(provider as UploadProvider));
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
