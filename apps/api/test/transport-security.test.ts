import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { apiListenConfig } = await import("../src/transport-security.js");

const fetchHandler = () => new Response("ok");

test("API listener defaults to HTTP without TLS files", () => {
  const config = apiListenConfig(fetchHandler, 8787, {});

  assert.equal(config.protocol, "http");
  assert.equal(config.options.port, 8787);
  assert.equal("serverOptions" in config.options, false);
});

test("API listener uses HTTPS when cert and key paths are set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakkr-api-tls-"));

  try {
    const certPath = path.join(root, "cert.pem");
    const keyPath = path.join(root, "key.pem");

    await writeFile(certPath, "dev cert");
    await writeFile(keyPath, "dev key");

    const config = apiListenConfig(fetchHandler, 9443, {
      RAKKR_API_TLS_CERT_PATH: certPath,
      RAKKR_API_TLS_KEY_PATH: keyPath,
    });

    assert.equal(config.protocol, "https");
    assert.equal(config.options.port, 9443);
    assert.equal(Buffer.isBuffer(config.options.serverOptions?.cert), true);
    assert.equal(Buffer.isBuffer(config.options.serverOptions?.key), true);
    assert.equal(typeof config.options.createServer, "function");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("API listener requires TLS cert and key together", () => {
  assert.throws(
    () =>
      apiListenConfig(fetchHandler, 9443, {
        RAKKR_API_TLS_CERT_PATH: "cert.pem",
      }),
    /RAKKR_API_TLS_CERT_PATH and RAKKR_API_TLS_KEY_PATH/,
  );
});
