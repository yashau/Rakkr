import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const destinationRoot = await mkdtemp(path.join(tmpdir(), "rakkr-upload-destinations-"));
process.env.RAKKR_UPLOAD_DESTINATION_STORE_PATH = path.join(destinationRoot, "destinations.json");

const { createUploadDestinationStore } = await import("../src/upload-destinations.js");

test.after(async () => {
  await rm(destinationRoot, { force: true, recursive: true });
});

test("reports upload destination configuration readiness", async () => {
  const store = createUploadDestinationStore();

  assert.deepEqual(await store.list(), []);

  // S3 enabled but missing only the secret access key.
  const created = await store.create({
    displayName: "Archive S3",
    enabled: true,
    kind: "s3",
    s3: { accessKeyId: "AKIAEXAMPLE", bucket: "rakkr-archive", region: "us-east-1" },
  });

  assert.equal(created.kind, "s3");
  assert.equal(created.status, "not_configured");
  assert.deepEqual(created.missingFields, ["s3.secretAccessKey"]);
  assert.equal(created.hasS3SecretAccessKey, false);

  const ready = await store.update(created.id, { s3SecretAccessKey: "s3-secret" });

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

  // SMB destination requires server/share/username/password.
  const smb = await store.create({
    displayName: "Recordings Share",
    enabled: true,
    kind: "smb",
    smb: { server: "files.example.lan", share: "recordings", username: "svc" },
  });

  assert.equal(smb.status, "not_configured");
  assert.deepEqual(smb.missingFields, ["smb.password"]);

  const smbReady = await store.update(smb.id, { smbPassword: "s3cr3t" });

  assert.equal(smbReady?.status, "ready");
  assert.equal(smbReady?.hasSmbPassword, true);
  assert.deepEqual(smbReady?.requiredFields, [
    "smb.server",
    "smb.share",
    "smb.username",
    "smb.password",
  ]);

  // resolveConfig hands the decrypted secret to the executor only.
  const resolved = await store.resolveConfig(smb.id);

  assert.equal(resolved?.smbPassword, "s3cr3t");
  assert.equal(resolved?.smb?.server, "files.example.lan");

  // Multiple destinations of each kind coexist; delete removes a single row.
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.delete(smb.id), true);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.find(smb.id), undefined);
});
