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

  const missing = await store.update("s3", {
    displayName: "Archive S3",
    enabled: true,
    target: "s3://rakkr-archive/meetings",
  });

  assert.equal(missing?.status, "not_configured");
  assert.deepEqual(missing?.missingFields, ["credentialRef"]);

  const pending = await store.update("s3", {
    credentialRef: "secret://rakkr/s3/archive",
  });

  assert.equal(pending?.status, "ready");
  assert.equal(pending?.configured, true);
  assert.equal(pending?.implemented, true);

  const mountedShare = await store.update("smb", {
    displayName: "Mounted Share",
    enabled: true,
    target: "/mnt/rakkr-recordings",
  });

  assert.equal(mountedShare?.status, "ready");
  assert.deepEqual(mountedShare?.requiredFields, ["target"]);
});
