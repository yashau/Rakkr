import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Reversible at-rest encryption for upload-provider secrets (SMB password, S3
// secret access key). These must be replayed to remote services, so one-way
// password hashing is not applicable. AES-256-GCM gives confidentiality plus an
// authentication tag so tampered/garbage ciphertext fails closed.

const ENC_PREFIX = "enc.v1:";
const DEV_FALLBACK_KEY = "rakkr-dev-insecure-secret-key-change-me";
const KEY_SALT = "rakkr-upload-provider-secret";
const MIN_SECRET_KEY_LENGTH = 16;

let cachedKey: { key: Buffer; source: string } | undefined;
let warnedDevFallback = false;

// Production deployments must not fall back to the well-known dev key (it is in
// the public repo, so it is effectively plaintext at rest). Default to required
// in production; `RAKKR_REQUIRE_SECRET_KEY=1`/`=0` forces the check on/off.
export function secretKeyRequired(): boolean {
  const explicit = process.env.RAKKR_REQUIRE_SECRET_KEY;

  if (explicit === "1") {
    return true;
  }

  if (explicit === "0") {
    return false;
  }

  return process.env.NODE_ENV === "production";
}

function secretKey(): Buffer {
  const provided = process.env.RAKKR_SECRET_KEY;
  const usable = provided && provided.length > 0 ? provided : undefined;

  if (secretKeyRequired() && (!usable || usable.length < MIN_SECRET_KEY_LENGTH)) {
    throw new Error(
      usable
        ? `RAKKR_SECRET_KEY is too short (min ${MIN_SECRET_KEY_LENGTH} chars); refusing to encrypt secrets with a weak key.`
        : "RAKKR_SECRET_KEY is not set; refusing to use the insecure development key in production.",
    );
  }

  const source = usable ?? DEV_FALLBACK_KEY;

  if (cachedKey?.source === source) {
    return cachedKey.key;
  }

  if (source === DEV_FALLBACK_KEY && !warnedDevFallback) {
    console.warn(
      "RAKKR_SECRET_KEY is not set; upload-provider secrets use an insecure development key. Set RAKKR_SECRET_KEY in production.",
    );
    warnedDevFallback = true;
  }

  const key = scryptSync(source, KEY_SALT, 32);
  cachedKey = { key, source };

  return key;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  if (!isEncryptedSecret(value)) {
    // Tolerate accidental plaintext rather than crashing the executor.
    return value;
  }

  const [ivB64, tagB64, dataB64] = value.slice(ENC_PREFIX.length).split(":");

  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("secret_ciphertext_malformed");
  }

  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
