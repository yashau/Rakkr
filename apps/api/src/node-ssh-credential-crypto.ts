import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
} from "node:crypto";

// SSH credential material for a recorder node. Private keys are encrypted at
// rest with the controller master key (they must be replayable to drive the
// Ansible SSH session, so one-way hashing does not apply). Public keys are
// emitted in OpenSSH `authorized_keys` form so they can be installed on nodes.

import { secretKeyRequired } from "./secret-box.js";

const ENC_PREFIX = "enc.ssh.v1:";
const DEV_FALLBACK_KEY = "rakkr-dev-insecure-ssh-master-key-change-me";
const KEY_SALT = "rakkr-node-ssh-credential";
const MIN_MASTER_KEY_LENGTH = 16;

let cachedKey: { key: Buffer; source: string } | undefined;
let warnedDevFallback = false;

export interface GeneratedSshKeyPair {
  fingerprint: string;
  privateKeyPem: string;
  publicKeyOpenssh: string;
}

// The controller master key is its own first-class secret (sourced from a k8s
// Secret in production); it falls back to the shared RAKKR_SECRET_KEY and then a
// loud dev-only key so local development keeps working.
function masterKey(): Buffer {
  const provided = process.env.RAKKR_NODE_SSH_MASTER_KEY || process.env.RAKKR_SECRET_KEY;
  const usable = provided && provided.length > 0 ? provided : undefined;

  if (secretKeyRequired() && (!usable || usable.length < MIN_MASTER_KEY_LENGTH)) {
    throw new Error(
      usable
        ? `RAKKR_NODE_SSH_MASTER_KEY is too short (min ${MIN_MASTER_KEY_LENGTH} chars); refusing to encrypt SSH private keys with a weak key.`
        : "RAKKR_NODE_SSH_MASTER_KEY (or RAKKR_SECRET_KEY) is not set; refusing to use the insecure development key in production.",
    );
  }

  const source = usable ?? DEV_FALLBACK_KEY;

  if (cachedKey?.source === source) {
    return cachedKey.key;
  }

  if (source === DEV_FALLBACK_KEY && !warnedDevFallback) {
    console.warn(
      "RAKKR_NODE_SSH_MASTER_KEY is not set; node SSH private keys use an insecure development key. Set RAKKR_NODE_SSH_MASTER_KEY (or RAKKR_SECRET_KEY) in production.",
    );
    warnedDevFallback = true;
  }

  const key = scryptSync(source, KEY_SALT, 32);
  cachedKey = { key, source };

  return key;
}

export function encryptPrivateKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptPrivateKey(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) {
    throw new Error("ssh_private_key_not_encrypted");
  }

  const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(":");

  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("ssh_private_key_ciphertext_malformed");
  }

  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// Generate an RSA keypair: the private key as PKCS#8 PEM (OpenSSH and Ansible's
// ssh transport both read this directly) and the public key in OpenSSH wire
// form for authorized_keys, with the standard SHA256 fingerprint.
export function generateSshKeyPair(comment = "rakkr-recorder-agent"): GeneratedSshKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const blob = opensshRsaBlob(publicKey);

  return {
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    privateKeyPem: privateKey,
    publicKeyOpenssh: `ssh-rsa ${blob.toString("base64")} ${comment}`,
  };
}

// SHA256 fingerprint for a node-provided OpenSSH public key line
// (`ssh-ed25519 AAAA... comment` / `ssh-rsa AAAA... comment`). Used at bootstrap
// where the agent generated the keypair, so the stored fingerprint is derived
// from the public key itself rather than trusted from the agent.
export function fingerprintForOpensshPublicKey(publicKeyLine: string): string {
  const base64 = publicKeyLine.trim().split(/\s+/)[1];

  if (!base64) {
    throw new Error("ssh_public_key_malformed");
  }

  const digest = createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64");

  return `SHA256:${digest.replace(/=+$/, "")}`;
}

function opensshRsaBlob(publicKeyPem: string): Buffer {
  const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" });

  if (!jwk.n || !jwk.e) {
    throw new Error("ssh_public_key_not_rsa");
  }

  const exponent = mpint(Buffer.from(jwk.e, "base64url"));
  const modulus = mpint(Buffer.from(jwk.n, "base64url"));

  return Buffer.concat([sshString(Buffer.from("ssh-rsa")), exponent, modulus]);
}

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);

  length.writeUInt32BE(value.length, 0);

  return Buffer.concat([length, value]);
}

function mpint(value: Buffer): Buffer {
  let bytes = value;

  // Strip leading zero bytes, then re-add one if the high bit is set so the
  // value stays positive (SSH mpint encoding).
  while (bytes.length > 1 && bytes[0] === 0) {
    bytes = bytes.subarray(1);
  }

  if (bytes.length > 0 && (bytes[0] & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }

  return sshString(bytes);
}
