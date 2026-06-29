import { z } from "zod";

export const s3ProviderPresetSchema = z.enum([
  "aws",
  "cloudflare_r2",
  "backblaze_b2",
  "wasabi",
  "digitalocean_spaces",
  "minio",
  "custom",
]);

// Non-secret SMB connection config. The password is write-only (see the upload
// provider update schema) and is never echoed back through config/status responses.
export const smbProviderConfigSchema = z.object({
  domain: z.string().trim().max(255).optional(),
  path: z.string().trim().max(1024).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  server: z.string().trim().min(1).max(255).optional(),
  share: z.string().trim().min(1).max(255).optional(),
  username: z.string().trim().min(1).max(255).optional(),
});

// Non-secret S3 connection config. The secret access key is write-only (see the
// upload provider update schema) and is never echoed back through config/status.
export const s3ProviderConfigSchema = z.object({
  accessKeyId: z.string().trim().min(1).max(512).optional(),
  bucket: z.string().trim().min(1).max(255).optional(),
  endpoint: z.string().trim().url().max(1024).optional(),
  forcePathStyle: z.boolean().optional(),
  preset: s3ProviderPresetSchema.optional(),
  prefix: z.string().trim().max(1024).optional(),
  region: z.string().trim().max(255).optional(),
});

export type S3ProviderPreset = z.infer<typeof s3ProviderPresetSchema>;
export type SmbProviderConfig = z.infer<typeof smbProviderConfigSchema>;
export type S3ProviderConfig = z.infer<typeof s3ProviderConfigSchema>;

export interface S3ProviderPresetInfo {
  defaultRegion?: string;
  endpointPlaceholder?: string;
  endpointRequired: boolean;
  forcePathStyle: boolean;
  label: string;
  preset: S3ProviderPreset;
  regionOptions?: string[];
  regionRequired: boolean;
}

const awsRegionOptions = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "eu-north-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "sa-east-1",
];

// UI-facing metadata for the S3 provider/region pickers. Presets seed sensible
// defaults (region, endpoint hint, path-style); the stored config keeps explicit
// values, and the executor only reads region/endpoint/bucket/credentials.
export const s3ProviderPresets: S3ProviderPresetInfo[] = [
  {
    endpointRequired: false,
    forcePathStyle: false,
    label: "Amazon S3",
    preset: "aws",
    regionOptions: awsRegionOptions,
    regionRequired: true,
  },
  {
    defaultRegion: "auto",
    endpointPlaceholder: "https://<account-id>.r2.cloudflarestorage.com",
    endpointRequired: true,
    forcePathStyle: true,
    label: "Cloudflare R2",
    preset: "cloudflare_r2",
    regionRequired: false,
  },
  {
    endpointPlaceholder: "https://s3.<region>.backblazeb2.com",
    endpointRequired: true,
    forcePathStyle: true,
    label: "Backblaze B2",
    preset: "backblaze_b2",
    regionRequired: true,
  },
  {
    endpointPlaceholder: "https://s3.<region>.wasabisys.com",
    endpointRequired: true,
    forcePathStyle: false,
    label: "Wasabi",
    preset: "wasabi",
    regionRequired: true,
  },
  {
    endpointPlaceholder: "https://<region>.digitaloceanspaces.com",
    endpointRequired: true,
    forcePathStyle: false,
    label: "DigitalOcean Spaces",
    preset: "digitalocean_spaces",
    regionRequired: true,
  },
  {
    defaultRegion: "us-east-1",
    endpointPlaceholder: "https://minio.example.com:9000",
    endpointRequired: true,
    forcePathStyle: true,
    label: "MinIO",
    preset: "minio",
    regionRequired: false,
  },
  {
    endpointPlaceholder: "https://s3.example.com",
    endpointRequired: true,
    forcePathStyle: true,
    label: "Custom S3-compatible",
    preset: "custom",
    regionRequired: false,
  },
];
