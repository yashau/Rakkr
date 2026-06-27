import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { apiListenConfig } = await import("../src/transport-security.js");

const fetchHandler = () => new Response("ok");
const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tls");

test("API listener defaults to HTTP without TLS files", () => {
  const config = apiListenConfig(fetchHandler, 8787, {});

  assert.equal(config.protocol, "http");
  assert.equal(config.options.port, 8787);
  assert.equal("serverOptions" in config.options, false);
});

test("API listener uses HTTPS when cert and key paths are set", async () => {
  const certPath = tlsFixture("active-cert.pem");
  const keyPath = tlsFixture("active-key.pem");
  const config = apiListenConfig(fetchHandler, 9443, {
    RAKKR_API_TLS_CERT_PATH: certPath,
    RAKKR_API_TLS_KEY_PATH: keyPath,
  });

  assert.equal(config.protocol, "https");
  assert.equal(config.options.port, 9443);
  assert.equal(Buffer.isBuffer(config.options.serverOptions?.cert), true);
  assert.equal(Buffer.isBuffer(config.options.serverOptions?.key), true);
  assert.equal(config.options.serverOptions?.requestCert, false);
  assert.equal(config.options.serverOptions?.rejectUnauthorized, false);
  assert.equal(typeof config.options.createServer, "function");
  assert.equal(config.tls?.active.certPath, certPath);
  assert.equal(config.tls?.active.keyPath, keyPath);
  assert.equal(
    config.tls?.active.certFingerprintSha256,
    await fixtureFingerprint("active-cert.pem"),
  );
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

test("API listener exposes next certificate material for rotation planning", async () => {
  const config = apiListenConfig(fetchHandler, 9443, {
    RAKKR_API_TLS_CERT_PATH: tlsFixture("active-cert.pem"),
    RAKKR_API_TLS_KEY_PATH: tlsFixture("active-key.pem"),
    RAKKR_API_TLS_NEXT_CERT_PATH: tlsFixture("next-cert.pem"),
    RAKKR_API_TLS_NEXT_KEY_PATH: tlsFixture("next-key.pem"),
    RAKKR_API_TLS_NEXT_NOT_BEFORE: "2026-07-01T00:00:00Z",
  });

  assert.equal(config.tls?.next?.certPath, tlsFixture("next-cert.pem"));
  assert.equal(config.tls?.next?.keyPath, tlsFixture("next-key.pem"));
  assert.equal(config.tls?.next?.notBefore, "2026-07-01T00:00:00Z");
  assert.equal(config.tls?.next?.certFingerprintSha256, await fixtureFingerprint("next-cert.pem"));
});

test("API listener requires next TLS cert and key together", () => {
  assert.throws(
    () =>
      apiListenConfig(fetchHandler, 9443, {
        RAKKR_API_TLS_CERT_PATH: tlsFixture("active-cert.pem"),
        RAKKR_API_TLS_KEY_PATH: tlsFixture("active-key.pem"),
        RAKKR_API_TLS_NEXT_CERT_PATH: tlsFixture("next-cert.pem"),
      }),
    /RAKKR_API_TLS_NEXT_CERT_PATH and RAKKR_API_TLS_NEXT_KEY_PATH/,
  );
});

test("API listener can require client certificates with a client CA", () => {
  const config = apiListenConfig(fetchHandler, 9443, {
    RAKKR_API_TLS_CERT_PATH: tlsFixture("active-cert.pem"),
    RAKKR_API_TLS_CLIENT_CA_PATH: tlsFixture("client-ca.pem"),
    RAKKR_API_TLS_CLIENT_CERT_MODE: "required",
    RAKKR_API_TLS_KEY_PATH: tlsFixture("active-key.pem"),
  });

  assert.equal(config.options.serverOptions?.requestCert, true);
  assert.equal(config.options.serverOptions?.rejectUnauthorized, true);
  assert.equal(Buffer.isBuffer(config.options.serverOptions?.ca), true);
  assert.equal(config.tls?.clientCertificates.mode, "required");
  assert.equal(config.tls?.clientCertificates.caPath, tlsFixture("client-ca.pem"));
});

test("API listener can request optional client certificates", () => {
  const config = apiListenConfig(fetchHandler, 9443, {
    RAKKR_API_TLS_CERT_PATH: tlsFixture("active-cert.pem"),
    RAKKR_API_TLS_CLIENT_CA_PATH: tlsFixture("client-ca.pem"),
    RAKKR_API_TLS_CLIENT_CERT_MODE: "optional",
    RAKKR_API_TLS_KEY_PATH: tlsFixture("active-key.pem"),
  });

  assert.equal(config.options.serverOptions?.requestCert, true);
  assert.equal(config.options.serverOptions?.rejectUnauthorized, false);
  assert.equal(config.tls?.clientCertificates.mode, "optional");
});

test("API listener requires a client CA for client certificate modes", () => {
  assert.throws(
    () =>
      apiListenConfig(fetchHandler, 9443, {
        RAKKR_API_TLS_CERT_PATH: tlsFixture("active-cert.pem"),
        RAKKR_API_TLS_CLIENT_CERT_MODE: "required",
        RAKKR_API_TLS_KEY_PATH: tlsFixture("active-key.pem"),
      }),
    /RAKKR_API_TLS_CLIENT_CA_PATH or RAKKR_API_TLS_CA_PATH/,
  );
});

test("API listener rejects unknown client certificate modes", () => {
  assert.throws(
    () =>
      apiListenConfig(fetchHandler, 9443, {
        RAKKR_API_TLS_CERT_PATH: tlsFixture("active-cert.pem"),
        RAKKR_API_TLS_CLIENT_CERT_MODE: "strict",
        RAKKR_API_TLS_KEY_PATH: tlsFixture("active-key.pem"),
      }),
    /RAKKR_API_TLS_CLIENT_CERT_MODE/,
  );
});

function tlsFixture(fileName: string) {
  return path.join(fixturesRoot, fileName);
}

async function fixtureFingerprint(fileName: string) {
  return createHash("sha256")
    .update(await readFile(tlsFixture(fileName)))
    .digest("hex");
}
