import assert from "node:assert/strict";
import { createPublicKey, createVerify, createSign } from "node:crypto";
import test from "node:test";

const { decryptPrivateKey, encryptPrivateKey, generateSshKeyPair } =
  await import("../src/node-ssh-credential-crypto.js");

test("generates an OpenSSH RSA public key, SHA256 fingerprint, and usable PEM private key", () => {
  const keyPair = generateSshKeyPair("rakkr-node_test");

  assert.match(keyPair.publicKeyOpenssh, /^ssh-rsa AAAA[A-Za-z0-9+/=]+ rakkr-node_test$/);
  assert.match(keyPair.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.match(keyPair.privateKeyPem, /BEGIN PRIVATE KEY/);

  // The private key must be a real RSA key usable for signatures (proving the
  // generated material is valid, not just well-formatted text).
  const signature = createSign("sha256").update("rakkr").sign(keyPair.privateKeyPem);
  const publicKeyPem = createPublicKey(keyPair.privateKeyPem)
    .export({ format: "pem", type: "spki" })
    .toString();
  const verified = createVerify("sha256").update("rakkr").verify(publicKeyPem, signature);

  assert.equal(verified, true);
});

test("each generated keypair is unique", () => {
  const first = generateSshKeyPair();
  const second = generateSshKeyPair();

  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(first.privateKeyPem, second.privateKeyPem);
});

test("private key encryption round-trips and is authenticated", () => {
  const { privateKeyPem } = generateSshKeyPair();
  const encrypted = encryptPrivateKey(privateKeyPem);

  assert.match(encrypted, /^enc\.ssh\.v1:/);
  assert.notEqual(encrypted, privateKeyPem);
  assert.equal(decryptPrivateKey(encrypted), privateKeyPem);
});

test("decrypt rejects plaintext and tampered ciphertext", () => {
  const encrypted = encryptPrivateKey("secret-key-material");
  // Corrupt the auth tag segment (enc.ssh.v1:iv:tag:data) so GCM verification fails.
  const segments = encrypted.split(":");
  segments[2] = `${segments[2][0] === "A" ? "B" : "A"}${segments[2].slice(1)}`;

  assert.throws(() => decryptPrivateKey("not-encrypted"), /not_encrypted/);
  assert.throws(() => decryptPrivateKey(segments.join(":")));
});
