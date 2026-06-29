import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const providerRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-providers-"));
process.env.RAKKR_UPLOAD_PROVIDER_STORE_PATH = path.join(providerRoot, "providers.json");

const { createUploadProviderStore } = await import("../src/upload-providers.js");

test.after(async () => {
  await rm(providerRoot, { force: true, recursive: true });
});

test("reports upload provider configuration readiness", async () => {
  const store = createUploadProviderStore();
  const defaults = await store.listStatuses();

  assert.equal(defaults.find((provider) => provider.provider === "stub")?.status, "ready");
  assert.equal(defaults.find((provider) => provider.provider === "s3")?.status, "disabled");
  assert.equal(defaults.find((provider) => provider.provider === "smb")?.status, "disabled");

  // S3 enabled but missing only the secret access key.
  const missing = await store.update("s3", {
    displayName: "Archive S3",
    enabled: true,
    s3: { accessKeyId: "AKIAEXAMPLE", bucket: "rakkr-archive", region: "us-east-1" },
  });

  assert.equal(missing?.status, "not_configured");
  assert.deepEqual(missing?.missingFields, ["s3.secretAccessKey"]);
  assert.equal(missing?.hasS3SecretAccessKey, false);

  const ready = await store.update("s3", { s3SecretAccessKey: "s3-secret" });

  assert.equal(ready?.status, "ready");
  assert.equal(ready?.configured, true);
  assert.equal(ready?.implemented, true);
  assert.equal(ready?.hasS3SecretAccessKey, true);
  assert.deepEqual(ready?.requiredFields, [
    "s3.bucket",
    "s3.accessKeyId",
    "s3.secretAccessKey",
    "s3.region|s3.endpoint",
  ]);
  // Secrets are never echoed back through status responses.
  assert.equal((ready as unknown as Record<string, unknown>).s3SecretAccessKey, undefined);
  assert.equal((ready?.s3 as Record<string, unknown> | undefined)?.secretAccessKey, undefined);

  // SMB requires server/share/username/password.
  const smbMissing = await store.update("smb", {
    displayName: "Recordings Share",
    enabled: true,
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
  });

  assert.equal(smbMissing?.status, "not_configured");
  assert.deepEqual(smbMissing?.missingFields, ["smb.password"]);

  const smbReady = await store.update("smb", { smbPassword: "s3cr3t" });

  assert.equal(smbReady?.status, "ready");
  assert.equal(smbReady?.hasSmbPassword, true);
  assert.deepEqual(smbReady?.requiredFields, [
    "smb.server",
    "smb.share",
    "smb.username",
    "smb.password",
  ]);

  // resolveConfig hands the decrypted secret to the executor only.
  const resolved = await store.resolveConfig("smb");

  assert.equal(resolved.smbPassword, "s3cr3t");
  assert.equal(resolved.smb?.server, "files.example.lan");
});
